"""Scene packages, release manifests and reproducible Blender exports."""
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / 'runtime'


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, data):
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as file:
        temp = Path(file.name)
        json.dump(data, file, ensure_ascii=False, separators=(',', ':'))
    temp.replace(path)


def blender_path():
    candidates = [os.environ.get('BLENDER_BIN'), shutil.which('blender'),
                  '/Applications/Blender.app/Contents/MacOS/Blender']
    return next((value for value in candidates if value and (Path(value).is_file() or shutil.which(value))), None)


def run_blender(script, source, args, timeout=150):
    executable = blender_path()
    if not executable:
        raise RuntimeError('需要安装 Blender 或设置 BLENDER_BIN。')
    start = [str(source)] if source else []
    try:
        result = subprocess.run(
            [executable, '--factory-startup', '--disable-autoexec', '-b', *start, '--python-exit-code', '1',
             '--python', str(RUNTIME / script), '--', *map(str, args)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError('Blender 处理超时，请重试。') from error
    if result.returncode:
        raise RuntimeError('Blender 处理场景失败。\n' + result.stdout[-2500:])


def source_path(folder):
    source = (folder / read_json(folder / 'recipe.json')['source']).resolve()
    if source.parent != folder.resolve() or source.suffix.lower() != '.blend' or not source.is_file():
        raise ValueError('场景包需要同目录的 Blender 源工程。')
    return source


def prepare(folder):
    run_blender('blender_job.py', source_path(folder), ['prepare', folder])


def release_manifest(folder, project, can_export=False):
    marker = folder / 'publication.json'
    if marker.is_file():
        release = read_json(marker)
        revision = release['revision']
        if type(revision) is not int or not 0 <= revision <= 999:
            raise ValueError('无效的场景版本。')
        assets = [f'r{index}/scene.glb' for index in range(revision + 1)]
        index = f'r{revision}/index.json'
        mode = 'photo'
    else:
        release = {'revision': 0, 'status': 'complete', 'message': ''}
        assets, index, mode = ['scene.glb'], 'index.json', 'ready'
    return {**release, 'project': project, 'assets': assets, 'index': index,
            'mode': mode, 'export': can_export}


def verify_progress(data, recipe):
    if not isinstance(data, dict) or not isinstance(data.get('values'), dict):
        raise ValueError('存档格式无效。')
    steps = {step['id']: step for chapter in recipe['chapters'] for step in chapter['steps']}
    owners = {name: step['id'] for step in steps.values() if not step.get('revisit') for name in step['parts']}
    values = data['values']
    for key, value in values.items():
        if key not in steps or type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError('存档包含无效的步骤或进度。')
        step = steps[key]
        if value and step.get('revisit') and any(values.get(owners[name], 0) != 1 for name in step['parts']):
            raise ValueError('存档的装配顺序无效。')
    active = data.get('active')
    if active is not None and (not isinstance(active, str) or active not in steps):
        raise ValueError('存档的当前步骤无效。')
    return {'values': values, 'active': active or next(iter(steps))}


def export_scene(folder, progress, target):
    progress = verify_progress(progress, read_json(folder / 'index.json'))
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
        staging = Path(temporary)
        write_json(staging / 'progress.json', progress)
        result = staging / 'project.blend'
        run_blender('blender_job.py', source_path(folder), ['save', folder, staging / 'progress.json', result])
        result.replace(target)
