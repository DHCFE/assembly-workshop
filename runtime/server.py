"""Run Assembly Workshop and its optional generation service on one origin."""
import argparse
from functools import partial
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import tempfile
from threading import BoundedSemaphore
from urllib.parse import unquote, urlsplit

from projects import Projects
from providers import NAMES, available
from scene_io import ROOT, blender_path, export_scene, read_json, release_manifest

DEMO_IDS = ('wood-village', 'spiral-mill')
MAX_IMAGE = 12 * 1024**2
PROJECT = re.compile(r'[a-f0-9]{32}')
LOOPBACK = {'localhost', '127.0.0.1', '::1'}


class Service:
    def __init__(self, site, directory, provider, token, origin):
        self.site = site.resolve()
        self.projects = Projects(directory, provider)
        self.provider = provider
        self.token = token
        self.origin = origin
        self.exports = BoundedSemaphore(1)

    @property
    def generation(self):
        return bool(blender_path() and available(self.provider))

    def scene(self, project):
        if project in DEMO_IDS:
            return ROOT / 'examples' / project
        if PROJECT.fullmatch(project):
            folder = self.projects.directory / project
            if (folder / 'publication.json').is_file() or (folder/'index.json').is_file():
                return folder
        raise FileNotFoundError('场景尚未发布。')


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, service, **kwargs):
        self.service = service
        super().__init__(*args, **kwargs)

    def response(self, status, payload, mime='application/json; charset=utf-8', headers=None):
        if isinstance(payload, dict) or isinstance(payload, list):
            payload = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def file(self, path, download=None):
        with path.open('rb') as stream:
            self.send_response(200)
            self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
            self.send_header('Content-Length', str(os.fstat(stream.fileno()).st_size))
            self.send_header('Cache-Control', 'private, max-age=300' if path.suffix=='.glb' else 'no-cache')
            self.send_header('X-Content-Type-Options', 'nosniff')
            if download:
                self.send_header('Content-Disposition', 'attachment; filename="'+download+'"')
            self.end_headers()
            shutil.copyfileobj(stream, self.wfile)

    def allowed_host(self):
        origin = urlsplit(self.service.origin)
        host = self.headers.get('Host')
        return host == origin.netloc or (origin.hostname in LOOPBACK and host in {
            f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'})

    def authorized(self):
        if not self.service.token:
            return True
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
        except CookieError:
            return False
        auth = self.headers.get('Authorization', '').removeprefix('Bearer ')
        supplied = auth or (cookie['workshop'].value if 'workshop' in cookie else '')
        return hmac.compare_digest(supplied.encode(), self.service.token.encode())

    def body(self, limit):
        size = int(self.headers.get('Content-Length', 0))
        if not 0 < size <= limit:
            raise ValueError('文件或请求过大。')
        self.connection.settimeout(30)
        data = self.rfile.read(size)
        if len(data) != size:
            raise ValueError('上传没有完成，请重试。')
        return data

    def dispatch(self, post=False):
        if not self.allowed_host():
            return self.response(403, {'error':'请使用配置的工作台地址。'})
        origin=self.headers.get('Origin')
        local_alias=urlsplit(self.service.origin).hostname in LOOPBACK and origin==f'http://{self.headers.get("Host")}'
        if post and origin != self.service.origin and not local_alias:
            return self.response(403, {'error':'请求须来自工作台页面。'})
        path = unquote(urlsplit(self.path).path)
        try:
            if path.startswith('/api/'):
                return self.api(path, post)
            project = re.fullmatch(r'/play/([a-z0-9-]+)/(.+)?', path)
            if project:
                return self.play(*project.groups(), post)
            if post:
                return self.response(404, {'error':'没有这个入口。'})
            location = (self.service.site / path.lstrip('/')).resolve()
            if not location.is_relative_to(self.service.site):
                raise FileNotFoundError()
            if location.is_dir():
                if not path.endswith('/'):
                    return self.response(308, {}, headers={'Location':path+'/'})
                location /= 'index.html'
            self.file(location)
        except BrokenPipeError:
            return
        except FileNotFoundError:
            return self.response(404, {'error':'场景或文件尚未就绪。'})
        except (ValueError, KeyError, UnicodeError, TypeError):
            return self.response(400, {'error':'请检查图片、项目编号或存档格式。'})
        except (RuntimeError, OSError):
            return self.response(500, {'error':'处理失败。请查看服务端日志或重试。'})

    def do_GET(self):
        return self.dispatch()

    def do_POST(self):
        return self.dispatch(post=True)

    def api(self, path, post):
        authorized = self.authorized()
        if not post and path=='/api/config':
            return self.response(200, {'needsAccess':not authorized, 'generation':self.service.generation,
                                      'provider':self.service.provider})
        if post and path=='/api/session':
            credentials=json.loads(self.body(4096))
            token=credentials.get('token','') if isinstance(credentials,dict) else ''
            if not self.service.token or not isinstance(token,str) or not hmac.compare_digest(token.encode(),self.service.token.encode()):
                return self.response(403, {'error':'访问口令不正确。'})
            cookie = SimpleCookie({'workshop':token})
            cookie['workshop']['httponly']=True
            cookie['workshop']['samesite']='Strict'
            cookie['workshop']['path']='/'
            if self.service.origin.startswith('https:'):
                cookie['workshop']['secure']=True
            return self.response(200, {'ok':True}, headers={'Set-Cookie':cookie.output(header='').strip()})
        if not authorized:
            return self.response(401, {'error':'请先输入工作台访问口令。'})
        jobs = self.service.projects
        if not post and path=='/api/projects':
            return self.response(200, jobs.list())
        if not post and (match:=re.fullmatch(r'/api/projects/([a-f0-9]{32})',path)):
            return self.response(200, read_json(jobs.directory / match[1] / 'job.json'))
        if post and not self.service.generation:
            return self.response(503, {'error':'请配置 Blender 和生成模型。'})
        if post and path=='/api/projects':
            photo = self.body(MAX_IMAGE)
            suffix = '.png' if photo.startswith(b'\x89PNG\r\n\x1a\n') else '.jpg' if photo.startswith(b'\xff\xd8\xff') else '.webp' if photo[:4]==b'RIFF' and photo[8:12]==b'WEBP' else None
            if not suffix:
                return self.response(400, {'error':'请选择 JPEG、PNG 或 WebP 图片。'})
            try:
                record = jobs.start(photo,suffix)
            except ValueError as error:
                return self.response(429, {'error':str(error)})
            return self.response(202,record)
        if post and (match:=re.fullmatch(r'/api/projects/([a-f0-9]{32})/retry',path)):
            try:
                return self.response(202,jobs.start(existing=match[1]))
            except ValueError as error:
                return self.response(409,{'error':str(error)})
        return self.response(404,{'error':'没有这个项目入口。'})

    def play(self, project, asset, post):
        if (project not in DEMO_IDS or post) and not self.authorized():
            return self.response(401,{'error':'请从照片开工页登录工作台。'})
        folder = self.service.scene(project)
        manifest = release_manifest(folder,project,bool(blender_path()) and self.authorized())
        if post and asset=='export':
            if not manifest['export']:
                return self.response(503,{'error':'导出需要 Blender。'})
            checkpoint = json.loads(self.body(1024**2))
            if not isinstance(checkpoint,dict) or checkpoint.get('format')!='assembly-workshop/1' or checkpoint.get('project')!=project:
                return self.response(400,{'error':'请选择这个项目的搭建存档。'})
            if not self.service.exports.acquire(blocking=False):
                return self.response(409,{'error':'另一个工程正在导出。'})
            try:
                with tempfile.TemporaryDirectory() as temporary:
                    target = Path(temporary) / 'assembly.blend'
                    export_scene((folder / manifest['index']).parent, checkpoint['progress'], target)
                    return self.file(target,'assembly.blend')
            finally:
                self.service.exports.release()
        if post:
            return self.response(404,{'error':'没有这个项目入口。'})
        if asset in (None,'index.html'):
            return self.file(ROOT/'web/index.html')
        if asset=='release.json':
            return self.response(200,manifest)
        if asset in [manifest['index'], *manifest['assets']]:
            return self.file(folder/asset)
        raise FileNotFoundError()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--origin', help='Public origin including scheme and port for reverse proxy deployments')
    parser.add_argument('--data-dir', type=Path, default=ROOT/'data')
    parser.add_argument('--provider', choices=NAMES, default=os.getenv('WORKSHOP_PROVIDER','off'))
    args=parser.parse_args()
    if not (ROOT/'dist/index.html').is_file():
        parser.error('Run npm ci and npm run build before starting the service.')
    if not 1<=args.port<=65535:
        parser.error('--port must be between 1 and 65535.')
    origin=args.origin or f'http://127.0.0.1:{args.port}'
    parsed=urlsplit(origin)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
        parser.error('--origin must contain only scheme, host and optional port.')
    token=os.getenv('WORKSHOP_ACCESS_TOKEN','')
    if parsed.hostname not in LOOPBACK and (len(token)<16 or parsed.scheme!='https'):
        parser.error('A public origin requires HTTPS and WORKSHOP_ACCESS_TOKEN (16+ characters).')
    service=Service(ROOT/'dist',args.data_dir.resolve()/'projects',args.provider,token,origin)
    server=ThreadingHTTPServer((args.bind,args.port),partial(Handler,service=service))
    print(f'WORKSHOP_URL={origin}/',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__=='__main__':
    main()
