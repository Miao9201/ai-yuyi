import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import urllib.error
from settings import ROOT,protect

class QQConsoleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);project=self.root/'upstream-v1.2.0';project.mkdir()
        for folder in ('console','src'):shutil.copytree(ROOT/'upstream-v1.2.0'/folder,project/folder)
        (project/'personas').mkdir();shutil.copy2(ROOT/'upstream-v1.2.0/personas/linmuwan.md',project/'personas/linmuwan.md')
        shutil.copy2(ROOT/'upstream-v1.2.0/package.json',project/'package.json')
        for name in ('settings.py','account_store.py','qq_settings.py','qq_runtime.py'):shutil.copy2(ROOT/name,self.root/name)
        (project/'data').mkdir();(self.root/'data').mkdir()
        (project/'data/config.json').write_text(json.dumps({'desktopAdapterEnabled':True,'defaultPersona':'linmuwan'}),encoding='utf8')
        (self.root/'data/config.json').write_text(json.dumps({'transport':'ilink','enabled':True,'run_id':'fixture'}),encoding='utf8')
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        self.base='http://127.0.0.1:'+str(port)
        env={**os.environ,'WX_CONSOLE_HOST':'127.0.0.1','WX_CONSOLE_PORT':str(port),'WX_DESKTOP_PYTHON':sys.executable}
        self.log=(self.root/'fixture.log').open('w');self.addCleanup(self.log.close)
        self.proc=subprocess.Popen(['node',str(project/'console/server.mjs')],cwd=project,env=env,stdout=self.log,stderr=self.log,creationflags=subprocess.CREATE_NO_WINDOW)
        self.addCleanup(self.stop)
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            try:self.request('/api/state');break
            except (OSError,ValueError):time.sleep(.05)

    def stop(self):
        if self.proc.poll() is None:self.proc.terminate();self.proc.wait(timeout=5)

    def request(self,path,body=None,origin=None):
        headers={'content-type':'application/json'}
        if origin:headers['Origin']=origin
        req=urllib.request.Request(self.base+path,data=json.dumps(body).encode('utf8') if body is not None else None,headers=headers)
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req,timeout=8) as res:return res.status,res.headers,res.read()
        except urllib.error.HTTPError as exc:return exc.code,exc.headers,exc.read()

    def test_qq_config_api_is_persistent_validated_local_only_and_hides_token(self):
        code,_,raw=self.request('/api/qq/config');self.assertEqual(code,200,raw)
        self.assertFalse(json.loads(raw)['config']['enabled'])
        payload={'privateUsers':['100001'],'groups':['200001'],'probability':0.25}
        code,_,raw=self.request('/api/qq/config',payload);self.assertEqual(code,200,raw)
        self.assertEqual(json.loads(self.request('/api/qq/config')[2])['config']['groups'],['200001'])
        file=self.root/'data/qq/connection.dpapi';file.write_bytes(protect(b'PRIVATE_QQ_FIXTURE_TOKEN'))
        self.assertNotIn(b'PRIVATE_QQ_FIXTURE_TOKEN',self.request('/api/qq/config')[2])
        for bad in ({'token':'bad'},{'groups':['../bad']},{'enabled':'true'},{'groupPersona':'private_fixture'}):
            self.assertNotEqual(self.request('/api/qq/config',bad)[0],200)
        self.assertEqual(self.request('/api/qq/config',payload,origin='https://foreign.example')[0],403)
        code,_,raw=self.request('/api/qq/state');self.assertEqual(code,200,raw);self.assertFalse(json.loads(raw)['installed'])
        self.assertEqual(self.request('/qq-ui.js')[0],200)
        self.assertIn(b'qqPrivateUsers',self.request('/')[2])

    def test_overview_reports_qq_only_mode_and_qq_log(self):
        code,_,body=self.request('/api/qq/config',{'enabled':True,'wechatEnabled':False})
        self.assertEqual(code,200,body)
        code,_,body=self.request('/api/state');self.assertEqual(code,200,body)
        data=json.loads(body)
        self.assertEqual(data['platforms'],{'wechat':False,'qq':True})
        self.assertFalse(data['qq']['installed'])
        folder=self.root/'data/qq';folder.mkdir(exist_ok=True)
        (folder/'run.log').write_text('QQ synthetic log entry',encoding='utf8')
        self.assertIn(b'QQ synthetic log entry',self.request('/api/logs')[2])

if __name__=='__main__':unittest.main()
