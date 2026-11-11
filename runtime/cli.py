"""Prepare, import and export portable Assembly Workshop scenes."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import shutil
import tempfile
from uuid import uuid4

from scene_io import ROOT, export_scene, prepare, read_json, release_manifest, source_path, write_json


def import_scene(folder, library):
    project = uuid4().hex
    library.mkdir(parents=True, exist_ok=True)
    manifest = release_manifest(folder, project)
    with tempfile.TemporaryDirectory(dir=library) as temporary:
        stage = Path(temporary) / project
        stage.mkdir()
        for asset in manifest['assets']:
            relative = Path(asset).parent
            original = folder / relative
            target = stage / relative
            target.mkdir(parents=True, exist_ok=True)
            files = ['recipe.json',source_path(original).name]
            if (original/'chunk.json').is_file():
                files.append('chunk.json')
            for name in files:
                shutil.copyfile(original/name,target/name)
            prepare(target)
        if manifest['mode']=='photo':
            write_json(stage/'publication.json', {'revision':manifest['revision'], 'status':'complete', 'message':'全部区域可搭建。'})
        write_json(stage/'job.json', {'id':project, 'status':'complete', 'message':'导入的 Blender 场景',
                   'created':datetime.now(timezone.utc).isoformat(), 'playUrl':f'../play/{project}/'})
        stage.replace(library/project)
    return project


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    actions=parser.add_subparsers(dest='command',required=True)
    actions.add_parser('prepare').add_argument('scene',type=Path)
    add=actions.add_parser('import')
    add.add_argument('scene',type=Path)
    add.add_argument('--data-dir',type=Path,default=ROOT/'data')
    save=actions.add_parser('export')
    save.add_argument('scene',type=Path)
    save.add_argument('checkpoint',type=Path)
    save.add_argument('output',type=Path)
    args=parser.parse_args()
    try:
        scene=args.scene.resolve()
        if args.command=='prepare':
            prepare(scene)
        elif args.command=='import':
            print('Imported project /play/'+import_scene(scene,args.data_dir.resolve()/'projects')+'/')
        else:
            checkpoint=read_json(args.checkpoint)
            if checkpoint.get('format')!='assembly-workshop/1' or args.output.suffix!='.blend':
                raise ValueError('需要 .assembly.json 存档和 .blend 输出路径。')
            manifest=release_manifest(scene,checkpoint['project'])
            export_scene((scene/manifest['index']).parent,checkpoint['progress'],args.output.resolve())
    except (ValueError,KeyError,OSError,RuntimeError) as error:
        parser.exit(1,str(error)+'\n')


if __name__=='__main__':
    main()
