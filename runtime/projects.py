"""Persistent photo jobs with atomic publication of completed Blender chunks."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import shutil
import tempfile
from threading import Lock
from uuid import uuid4

from photo_recipe import first_phase
from providers import generate_recipe
from scene_io import prepare, read_json, run_blender, write_json


class Projects:
    def __init__(self, directory, provider):
        self.directory = directory
        self.provider = provider
        self.lock = Lock()
        self.workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix='scene')
        directory.mkdir(parents=True, exist_ok=True)
        for record in self.list():
            if record['status'] == 'building':
                self.stop(directory / record['id'], '上次制作已暂停，可以继续生成。')

    def list(self):
        return sorted((read_json(path) for path in self.directory.glob('*/job.json')),
                      key=lambda job: job['created'], reverse=True)

    def update(self, folder, **changes):
        record = read_json(folder / 'job.json')
        write_json(folder / 'job.json', {**record, **changes})

    def publish(self, folder, revision, status, message):
        write_json(folder / 'publication.json', {'revision': revision, 'status': status, 'message': message})
        self.update(folder, status=status, message=message, revision=revision, playUrl=f'../play/{folder.name}/')

    def stop(self, folder, message):
        marker = folder / 'publication.json'
        if marker.is_file():
            self.publish(folder, read_json(marker)['revision'], 'stopped', message)
        else:
            self.update(folder, status='stopped', message=message)

    def start(self, photo=None, suffix=None, existing=None):
        with self.lock:
            if sum(job['status'] == 'building' for job in self.list()) >= 2:
                raise ValueError('已有两个项目在制作，请稍后再试。')
            if existing:
                folder = self.directory / existing
                record = read_json(folder / 'job.json')
                if record['status'] != 'stopped':
                    raise ValueError('只有暂停的项目可以继续。')
                self.update(folder, status='building', message='正在继续制作…')
            else:
                folder = self.directory / uuid4().hex
                folder.mkdir()
                (folder / ('reference' + suffix)).write_bytes(photo)
                write_json(folder / 'job.json', {'id': folder.name, 'status': 'building',
                    'created': datetime.now(timezone.utc).isoformat(), 'message': '正在准备地台…'})
            self.workers.submit(self.generate, folder)
            return read_json(folder / 'job.json')

    def phase(self, folder, revision, recipe):
        target = folder / f'r{revision}'
        if all((target / name).is_file() for name in ('source.blend', 'index.json', 'scene.glb')):
            return
        with tempfile.TemporaryDirectory(dir=folder) as temporary:
            work = Path(temporary) / f'r{revision}'
            work.mkdir()
            spec = work / 'phase.json'
            write_json(spec, recipe)
            prior = folder / f'r{revision-1}' if revision else None
            run_blender('photo_mesh.py', prior / 'source.blend' if prior else None,
                        [work, spec, revision, *([prior / 'recipe.json'] if prior else [])])
            prepare(work)
            if target.exists():
                shutil.rmtree(target)
            work.replace(target)

    def generate(self, folder):
        try:
            image = next(folder.glob('reference.*'))
            marker = folder / 'publication.json'
            revision = read_json(marker)['revision'] if marker.is_file() else -1
            if revision < 0:
                with ThreadPoolExecutor(max_workers=1) as pool:
                    primary = pool.submit(generate_recipe, self.provider, folder, image, 1)
                    self.phase(folder, 0, first_phase())
                    self.publish(folder, 0, 'building', '地台可搭建。AI 正在按照片制作主体。')
                    main = primary.result()
            else:
                self.publish(folder, revision, 'building', '正在继续制作后续区域。')
                main = generate_recipe(self.provider, folder, image, 1)
            if revision < 1:
                self.phase(folder, 1, main)
                self.publish(folder, 1, 'building', '主体已经开放。屋面和细节正在制作。')
            if revision < 2:
                self.phase(folder, 2, generate_recipe(self.provider, folder, image, 2, main))
            self.publish(folder, 2, 'complete', '所有区域已开放。')
        except Exception as error:
            (folder / 'error.log').write_text(str(error), encoding='utf-8')
            self.stop(folder, str(error).splitlines()[0] if isinstance(error, (RuntimeError, ValueError))
                      else '生成任务中断。可继续已发布的区域或重试。')
