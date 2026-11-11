import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from threading import Thread
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'runtime'))
from scene_io import blender_path, verify_progress


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        return sock.getsockname()[1]


class FakeVision(BaseHTTPRequestHandler):
    fail_details=True

    def log_message(self,*args):
        pass

    def do_POST(self):
        payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        image=payload['messages'][0]['content'][1]['image_url']['url']
        if not image.startswith('data:image/png;base64,') or payload['response_format']['type']!='json_schema':
            self.send_error(400)
            return
        details='阶段二，参考照片' in payload['messages'][0]['content'][0]['text']
        if details and self.fail_details:
            type(self).fail_details=False
            self.send_error(503)
            return
        plan={'chapter':'屋面' if details else '主体','parts':[
            {'label':f'部件 {i}','shape':'gable' if details else 'box','center':[i*1.6-1.6,0,2 if details else .7],
             'size':[1.5,1.4,1.2],'color':'#c5aa81','turn':0,'action':'lower','interaction':'auto','placement':'auto'}
            for i in range(3)]}
        data=json.dumps({'choices':[{'message':{'content':json.dumps(plan)}}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.vision=ThreadingHTTPServer(('127.0.0.1',0),FakeVision)
        Thread(target=cls.vision.serve_forever,daemon=True).start()
        cls.addClassCleanup(cls.vision.server_close)
        cls.addClassCleanup(cls.vision.shutdown)
        service_port=port()
        cls.url=f'http://127.0.0.1:{service_port}'
        env={**os.environ,'WORKSHOP_AI_BASE_URL':f'http://127.0.0.1:{cls.vision.server_port}/v1',
             'WORKSHOP_AI_MODEL':'fixture','WORKSHOP_ACCESS_TOKEN':'fixture-access-token'}
        log=open(Path(cls.temp.name)/'server.log','wb')
        cls.addClassCleanup(log.close)
        cls.service=subprocess.Popen([sys.executable,str(ROOT/'runtime/server.py'),'--port',str(service_port),
                   '--data-dir',cls.temp.name,'--provider','openai-compatible'],env=env,stdout=log,stderr=log)
        cls.addClassCleanup(cls.stop)
        for _ in range(50):
            try:
                cls.get('/api/config')
                return
            except URLError:
                time.sleep(.1)
        raise RuntimeError('Service did not start: '+(Path(cls.temp.name)/'server.log').read_text())

    @classmethod
    def stop(cls):
        cls.service.terminate()
        cls.service.wait(timeout=15)

    @classmethod
    def fetch(cls,path,data=None,auth=True):
        headers={'Origin':cls.url}
        if auth:
            headers['Authorization']='Bearer fixture-access-token'
        return urlopen(Request(cls.url+path,data=data,headers=headers),timeout=30)

    @classmethod
    def get(cls,path,data=None,auth=True):
        with cls.fetch(path,data,auth) as response:
            return json.load(response)

    def test_private_jobs_and_public_demo(self):
        self.assertTrue(self.get('/api/config',auth=False)['needsAccess'])
        self.assertFalse(self.get('/play/wood-village/release.json',auth=False)['export'])
        with self.assertRaises(HTTPError) as error:
            self.get('/api/projects',auth=False)
        self.assertEqual(error.exception.code,401)
        error.exception.close()
        self.assertEqual(self.get('/play/wood-village/release.json')['revision'],3)

    @unittest.skipUnless(os.getenv('WORKSHOP_TEST_BLENDER')=='1' and blender_path(),'requires Blender')
    def test_photo_release_retry_and_export(self):
        # A small valid PNG travels through the same upload and vision API route as user files.
        photo=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3ioAAAAASUVORK5CYII=')
        job=self.get('/api/projects',photo)
        endpoint='/api/projects/'+job['id']
        project='/play/'+job['id']+'/'
        def wait(status):
            for _ in range(120):
                state=self.get(endpoint)
                if state['status']==status:
                    return state
                time.sleep(.25)
            self.fail(f'Did not reach {status}: {state}')
        stopped=wait('stopped')
        self.assertEqual(stopped['revision'],1,stopped)
        first=self.get(project+'r1/index.json')['chapters']
        self.get(endpoint+'/retry',b'')
        self.assertEqual(wait('complete')['revision'],2)
        release=self.get(project+'release.json')
        final=self.get(project+release['index'])['chapters']
        self.assertEqual(final[:len(first)],first)
        checkpoint={'format':'assembly-workshop/1','project':job['id'],'progress':{'active':'1','values':{'1':1}}}
        with self.fetch(project+'export',json.dumps(checkpoint).encode()) as result:
            self.assertGreater(len(result.read()),10_000)

    def test_invalid_progress_is_rejected(self):
        recipe={'chapters':[{'steps':[{'id':'1','parts':['beam']}]}]}
        with self.assertRaises(ValueError):
            verify_progress({'values':{'100':1}},recipe)


if __name__=='__main__':
    unittest.main()
