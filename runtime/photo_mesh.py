"""Make editable meshes from the photo recipe inside a background Blender job."""
import json
from math import cos,pi,radians,sin
from pathlib import Path
import sys
import bpy
from mathutils import Matrix, Vector


def linear(value):
    return value/12.92 if value<=.04045 else ((value+.055)/1.055)**2.4


def material(color):
    mat=bpy.data.materials.get(color) or bpy.data.materials.new(color)
    rgb=[linear(int(color[i:i+2],16)/255) for i in (1,3,5)]
    mat.diffuse_color=(*rgb,1)
    mat.use_nodes=True
    bsdf=mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value=mat.diffuse_color
    bsdf.inputs['Roughness'].default_value=.81
    return mat


def prism(profile,depth,axis):
    if axis==1:
        vertices=[(a,side*depth/2,b) for side in (-1,1) for a,b in profile]
    else:
        vertices=[(side*depth/2,a,b) for side in (-1,1) for a,b in profile]
    count=len(profile)
    faces=[tuple(range(count)),tuple(reversed(range(count,2*count)))]
    faces += [(i,count+i,count+(i+1)%count,(i+1)%count) for i in range(count)]
    return vertices,faces


def boxes(dimensions):
    vertices,faces=[],[]
    for center,size in dimensions:
        x,y,z=[v/2 for v in size]
        start=len(vertices)
        vertices.extend((a+center[0],b+center[1],c+center[2])
            for a,b,c in [(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),(-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)])
        faces.extend(tuple(start+i for i in face) for face in
            [(3,2,1,0),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)])
    return vertices,faces


def shape(kind,size):
    x,y,z=size
    if kind=='gable':
        return prism([(-x/2,-z/2),(x/2,-z/2),(0,z/2)],y,1)
    if kind=='hip':
        return ([(-x/2,-y/2,-z/2),(x/2,-y/2,-z/2),(x/2,y/2,-z/2),(-x/2,y/2,-z/2),
                 (0,-y*.28,z/2),(0,y*.28,z/2)],
                [(3,2,1,0),(0,1,4),(1,2,5,4),(2,3,5),(3,0,4,5)])
    if kind=='stairs':
        profile=[(-y/2,-z/2),(y/2,-z/2),(y/2,z/2)]
        for i in range(5,-1,-1):
            at=-y/2+y*i/6
            top=-z/2+z*(i+1)/6
            profile.extend([(at,top),(at,top-z/6)])
        return prism(profile[:-1],x,0)
    if kind=='arch':
        radius=x/2
        arch_height=min(z*.52,radius)
        spring=z/2-arch_height
        thickness=min(x*.16,z*.26)
        outer=[(radius*cos(i*pi/24),spring+arch_height*sin(i*pi/24)) for i in range(25)]
        inner=[((radius-thickness)*cos(i*pi/24),spring+(arch_height-thickness*.70)*sin(i*pi/24))
               for i in range(24,-1,-1)]
        profile=[(radius,-z/2),*outer,(-radius,-z/2),(-radius+thickness,-z/2),
                 *inner,(radius-thickness,-z/2)]
        return prism(profile,y,1)
    if kind=='wheel':
        count=32
        points=[(x/2*radius*cos(i*2*pi/count),side*y/2,z/2*radius*sin(i*2*pi/count))
                for side in (-1,1) for radius in (1,.76) for i in range(count)]
        faces=[]
        for i in range(count):
            j=(i+1)%count
            faces.extend([(i,j,j+count,i+count),(i+2*count,i+3*count,j+3*count,j+2*count),
                          (i,i+2*count,j+2*count,j),(i+count,j+count,j+3*count,i+3*count)])
        for i in range(8):
            rotation=Matrix.Rotation(i*pi/4,3,'Y')
            spoke,polys=boxes([((0,0,z*.20),(min(x,z)*.065,y*.64,z*.41))])
            start=len(points)
            points.extend(tuple(rotation@Vector(v)) for v in spoke)
            faces.extend(tuple(start+j for j in face) for face in polys)
        return points,faces
    if kind in ('cylinder','hedge'):
        count=18
        vertices=[(x/2*cos(i*2*pi/count),y/2*sin(i*2*pi/count),height)
                  for height in (-z/2,z/2) for i in range(count)]
        if kind=='hedge':
            vertices=[(a*(.76 if i<count else .90),b*(.76 if i<count else .90),c)
                      for i,(a,b,c) in enumerate(vertices)]
        faces=[tuple(reversed(range(count))),tuple(range(count,2*count))]
        faces += [(i,(i+1)%count,(i+1)%count+count,i+count) for i in range(count)]
        return vertices,faces
    if kind=='posts':
        return boxes([((-x/2+x*(i+.5)/6,0,0),(x*.085,y*.62,z)) for i in range(6)])
    return boxes([((0,0,0),size)])


def add_part(part,name,collection):
    vertices,faces=shape(part['shape'],part['size'])
    data=bpy.data.meshes.new(name)
    data.from_pydata(vertices,[],faces)
    data.update()
    import bmesh
    with_mesh=bmesh.new()
    try:
        with_mesh.from_mesh(data)
        bmesh.ops.recalc_face_normals(with_mesh,faces=list(with_mesh.faces))
        with_mesh.to_mesh(data)
    finally:
        with_mesh.free()
    obj=bpy.data.objects.new(name,data)
    collection.objects.link(obj)
    obj.location=part['center']
    obj.rotation_euler.z=radians(part['turn'])
    obj.data.materials.append(material(part['color']))
    bevel=obj.modifiers.new('边缘倒角','BEVEL')
    bevel.width=min(.035,min(part['size'])*.12)
    bevel.segments=2
    return obj


def step_for(part,name):
    action=part['action']
    x,y,z=part['center']
    w,d,h=part['size']
    entry={'op':action,'title':part['label'],'parts':[name]}
    if 'interaction' in part:
        entry['interaction']=part['interaction']
    if 'placement' in part:
        entry['placement']=part['placement']
    if action in ('lower','raise','slide','insert','align'):
        entry['offset']={
            'lower':[0,0,max(.65,min(2.4,h*.62))],
            'raise':[0,0,-max(.52,min(1.5,h*.58))],
            'slide':[-max(.9,min(2.2,w*.55)),0,0],
            'insert':[0,-max(.7,min(1.4,d*.75)),0],
            'align':[max(.45,min(1.1,w*.55)),-.55,.45],
        }[action]
    elif action in ('hinge','turn'):
        entry.update(axis=0 if action=='hinge' else 2,angle=53 if action=='hinge' else 84,
                     pivot=[x,y+d/2 if action=='hinge' else y,z])
    elif action in ('stretch','expand','spread'):
        entry.update(axis=2,pivot=[x,y,z-h/2])
    elif action=='pour':
        entry.update(axis=2,reverse=True)
    elif action=='plant':
        entry['axis']=2
    elif action=='tread':
        entry['axis']=1
    else:
        entry['axis']=0 if w>=d else 1
    return entry


target,phase_file,revision,*prior=sys.argv[sys.argv.index('--')+1:]
root=Path(target)
phase=json.loads(Path(phase_file).read_text(encoding='utf-8'))
if prior:
    recipe=json.loads(Path(prior[0]).read_text(encoding='utf-8'))
else:
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    recipe={'version':1,'title':'照片建造场','source':'source.blend','view':[8,-23,15],'chapters':[]}
collection=bpy.data.collections.new(phase['chapter'])
bpy.context.scene.collection.children.link(collection)
names=[]
steps=[]
for index,part in enumerate(phase['parts'],1):
    name=f'{int(revision)+1:02d}-{index:02d} · {part["label"]}'
    names.append(name)
    add_part(part,name,collection)
    steps.append(step_for(part,name))
recipe['chapters'].append({'title':phase['chapter'],'steps':steps})
(root/'recipe.json').write_text(json.dumps(recipe,ensure_ascii=False),encoding='utf-8')
(root/'chunk.json').write_text(json.dumps(names,ensure_ascii=False),encoding='utf-8')
bpy.context.scene.unit_settings.system='METRIC'
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(root/'source.blend'))
