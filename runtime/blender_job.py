"""Build an interaction index from the original Blender scene and save work in progress."""
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector, Quaternion

sys.path.insert(0,str(Path(__file__).resolve().parent))
from interaction_rules import PLACEMENT, resolve_interaction, resolve_placement

TRANSLATE = {'lower','raise','slide','align','insert','seat','bridge','place'}
ROTATE = {'turn','hinge'}
SCALE = {'spread','expand','stretch'}
CLIP = {'sweep','pour','flow','tread','plant'}
OPS = TRANSLATE | ROTATE | SCALE | CLIP | {'bend','cut'}
FRAMES = 40
IDENTITY = Matrix.Identity(4)


def rounded(values):
    return [round(float(value),6) for value in values]


def box_bounds(objects):
    points = [obj.matrix_world @ Vector(v) for obj in objects for v in obj.bound_box]
    return [Vector([method(v[i] for v in points) for i in range(3)]) for method in (min,max)]


def compile_recipe(recipe,objects):
    claimed = set()
    steps = []
    for chapter in recipe['chapters']:
        for step in chapter['steps']:
            kind = step['op']
            if kind not in OPS or not step.get('parts'):
                raise ValueError(f'Unknown or empty operation: {kind}')
            step['interaction'] = resolve_interaction(kind,step.get('interaction','auto'))
            step['placement'] = resolve_placement(kind,step.get('placement','auto'),step.get('revisit',False))
            names = step['parts']
            if not set(names) <= objects.keys() or len(names)!=len(set(names)):
                raise ValueError(f'Invalid targets: {names}')
            if step.get('revisit'):
                if not set(names)<=claimed:
                    raise ValueError('A revisit requires the parts to have been installed.')
            else:
                if claimed.intersection(names):
                    raise ValueError(f'Repeated target: {names}')
                claimed.update(names)
            targets = [objects[name] for name in names]
            lo,hi = box_bounds(targets)
            mid = (lo+hi)/2
            step.update(id=str(len(steps)+1), bounds=[rounded(lo),rounded(hi)])
            step.setdefault('pivot',rounded(mid))
            step.setdefault('axis',2)
            if step['axis'] not in (0,1,2):
                raise ValueError('Axis must be x, y or z.')
            frames,handles = [],[]
            assembly = Vector(step.get('assemblyOffset',(0,0,0)))
            for i in range(FRAMES+1):
                p = i/FRAMES
                delta = transform(step,p)
                positioned = Matrix.Translation(assembly) @ delta if step.get('assemblyOffset') else delta
                loc,rot,scale = positioned.decompose()
                frames.append(rounded([*loc,rot.x,rot.y,rot.z,rot.w,*scale]))
                handles.append(rounded(handle(step,lo,hi,delta,p)+assembly))
            step.update(frames=frames,handles=handles)
            if step.get('assemblyOffset'):
                step['bounds']=[rounded(lo+assembly),rounded(hi+assembly)]
            steps.append(step)
    if claimed != objects.keys():
        raise ValueError(f'Missing source meshes: {sorted(objects.keys()-claimed)}')
    return steps


def transform(step,p):
    kind = step['op']
    pivot = Vector(step['pivot'])
    if kind in TRANSLATE:
        return Matrix.Translation(Vector(step['offset'])*(1-p))
    if kind in ROTATE:
        motion = Matrix.Rotation(math.radians(step['angle'])*(1-p),4,'XYZ'[step['axis']])
    elif kind in SCALE:
        axes = (0,1) if kind=='spread' else (step['axis'],) if kind=='stretch' else (0,1,2)
        factors = [(.12+.88*p if i in axes else 1.) for i in range(3)]
        motion = Matrix.Diagonal((*factors,1))
    else:
        return IDENTITY
    return Matrix.Translation(pivot) @ motion @ Matrix.Translation(-pivot)


def bend_offset(step,point):
    lo,hi = step['bounds']
    axis = step['axis']
    t = (point[axis]-lo[axis])/max(.0001,hi[axis]-lo[axis])
    return step.get('strength',1.2)*(t-.5)**2*4


def handle(step,lo,hi,delta,p):
    mid = (lo+hi)/2
    op,axis = step['op'],step['axis']
    center = Vector((mid.x,lo.y,hi.z))
    if op in CLIP:
        a,b = (hi,lo) if step.get('reverse') else (lo,hi)
        center[axis] = a[axis]+(b[axis]-a[axis])*p
        return center
    if op=='cut':
        center = Vector(step['blank']['center'])
        center[axis] += step['blank']['size'][axis]*(p-.5)
        center.y -= .24
        center.z += .88
        return center
    if op=='bend':
        center[axis] = hi[axis]
        center[step.get('direction',1)] += bend_offset(step,center)*(1-p)
        return center
    if op in ROTATE:
        pivot = Vector(step['pivot'])
        candidates = [Vector((x,y,z)) for x in (lo.x,hi.x) for y in (lo.y,hi.y) for z in (lo.z,hi.z)]
        center = max(candidates,key=lambda v:sum((v[i]-pivot[i])**2 for i in range(3) if i!=axis))
    return delta @ center


def bake_preview_mesh(obj):
    if obj.modifiers:
        graph = bpy.context.evaluated_depsgraph_get()
        obj.data = bpy.data.meshes.new_from_object(obj.evaluated_get(graph),
                   preserve_all_data_layers=True,depsgraph=graph)
        obj.modifiers.clear()


def shape_bend(obj,step):
    if obj.data.users>1:
        obj.data = obj.data.copy()
    obj.shape_key_add(name='Basis')
    shape = obj.shape_key_add(name='搭建起始弧度')
    world,inverse = obj.matrix_world,obj.matrix_world.inverted()
    for vertex in shape.data:
        point = world @ vertex.co
        point[step.get('direction',1)] += bend_offset(step,point)
        vertex.co = inverse @ point
    return shape


def prepare(root,recipe,objects,steps):
    chunk=root/'chunk.json'
    selected=set(json.loads(chunk.read_text(encoding='utf-8'))) if chunk.exists() else set(objects)
    if not selected or not selected<=objects.keys():
        raise ValueError('Invalid mesh chunk')
    bpy.ops.object.select_all(action='DESELECT')
    for name in selected:
        obj=objects[name]
        bake_preview_mesh(obj)
        obj['workshop_id'] = name
        obj.select_set(True)
    for step in steps:
        if step['op']=='bend':
            for name in set(step['parts']) & selected:
                obj=objects[name]
                shape_bend(obj,step)
    bpy.ops.export_scene.gltf(filepath=str(root/'scene.glb'),export_format='GLB',
        use_selection=True,export_extras=True,export_yup=False,export_apply=False,export_cameras=False,
        export_lights=False,export_animations=False,export_morph=True)
    (root/'index.json').write_text(json.dumps(recipe,ensure_ascii=False,separators=(',',':')),encoding='utf-8')


def interpolated_delta(step,p):
    k=p*FRAMES
    i=min(FRAMES-1,int(k))
    t=k-i
    a,b=step['frames'][i:i+2]
    loc=Vector(a[:3]).lerp(Vector(b[:3]),t)
    rot=Quaternion((a[6],*a[3:6])).slerp(Quaternion((b[6],*b[3:6])),t)
    scale=Vector(a[7:]).lerp(Vector(b[7:]),t)
    return Matrix.LocRotScale(loc,rot,scale)


def clip_mesh(obj,step,p):
    lo,hi=step['bounds']
    axis=step['axis']
    direction=-1 if step.get('reverse') else 1
    boundary=(hi[axis]+(lo[axis]-hi[axis])*p if direction<0 else lo[axis]+(hi[axis]-lo[axis])*p)
    world=obj.matrix_world
    normal=Vector([direction if i==axis else 0 for i in range(3)])
    point=Vector([boundary if i==axis else 0 for i in range(3)])
    mesh=bmesh.new()
    try:
        mesh.from_mesh(obj.data)
        bmesh.ops.bisect_plane(mesh,geom=[*mesh.verts,*mesh.edges,*mesh.faces],
            plane_co=world.inverted()@point,plane_no=world.to_3x3().transposed()@normal,
            dist=.0001,clear_outer=True)
        if obj.data.users>1:
            obj.data=obj.data.copy()
        mesh.to_mesh(obj.data)
    finally:
        mesh.free()


def blank(step,p):
    config=step['blank']
    center=Vector(config['center'])
    size=Vector(config['size'])
    axis=step['axis']
    center[axis]+=size[axis]*p/2
    size[axis]*=1-p
    bpy.ops.mesh.primitive_cube_add(size=1,location=center)
    obj=bpy.context.object
    obj.name=config.get('label','尚未切除的封石')
    obj.scale=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    material=bpy.data.materials.get(config.get('material','浅砂石'))
    if material:
        obj.data.materials.append(material)


def save(recipe,objects,steps,progress,target):
    values=progress['values']
    active=progress.get('active')
    originals={name:obj.matrix_world.copy() for name,obj in objects.items()}
    visible=set()
    for step in steps:
        p=values.get(step['id'],0)
        if p==0 and (step['id']!=active or step['placement']=='tray'):
            continue
        if p==PLACEMENT['seatedValue']:
            p=0
        if step.get('revisit') and any(name not in visible for name in step['parts']):
            continue
        visible.update(step['parts'])
        if p>=1 and not step.get('assemblyOffset'):
            if step.get('revisit'):
                for name in step['parts']:
                    objects[name].matrix_world=originals[name]
            continue
        for name in step['parts']:
            obj=objects[name]
            if step['op'] in CLIP:
                clip_mesh(obj,step,p)
            elif step['op']=='bend':
                shape_bend(obj,step).value=1-p
            elif step['op'] in TRANSLATE|ROTATE|SCALE:
                obj.matrix_world=interpolated_delta(step,p)@originals[name]
        if step['op']=='cut':
            blank(step,p)
    for name,obj in objects.items():
        if name not in visible:
            obj.hide_set(True)
            obj.hide_render=True
    bpy.context.preferences.filepaths.save_version=0
    bpy.ops.wm.save_as_mainfile(filepath=str(target))


mode,root_arg,*args=sys.argv[sys.argv.index('--')+1:]
root=Path(root_arg)
recipe=json.loads((root/'recipe.json').read_text(encoding='utf-8'))
objects={obj.name:obj for obj in bpy.context.scene.objects if obj.type=='MESH'}
steps=compile_recipe(recipe,objects)
if mode=='prepare':
    prepare(root,recipe,objects,steps)
elif mode=='save':
    progress=json.loads(Path(args[0]).read_text(encoding='utf-8'))
    save(recipe,objects,steps,progress,Path(args[1]))
