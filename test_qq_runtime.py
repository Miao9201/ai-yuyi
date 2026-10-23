import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch,Mock
import qq_runtime as runtime

class QQRuntimeTests(unittest.TestCase):
    def test_configure_validates_independent_shell_and_never_exposes_token(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(runtime,'DATA',Path(tmp)/'data'):
            root=Path(tmp)/'shell';core=root/'versions/test/resources/app/napcat';core.mkdir(parents=True)
            for file in [root/'QQ.exe',root/'NapCatWinBootMain.exe',core/'napcat.mjs']:file.write_bytes(b'fixture')
            result=runtime.configure(str(root));self.assertTrue(result['installed']);self.assertNotIn('token',result)
            config=json.loads((core/'config/webui.json').read_text());self.assertEqual(config['host'],'127.0.0.1');self.assertGreater(len(config['token']),20)
            with self.assertRaises(ValueError):runtime.configure(str(root/'missing'))

    def test_start_uses_onekey_argument_contract_and_does_not_touch_existing_qq(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(runtime,'DATA',Path(tmp)),patch.object(runtime,'paths',return_value={'shell':Path(tmp),'core':Path(tmp),'port':6099}),patch.object(runtime,'available',return_value=False),patch.object(runtime.subprocess,'Popen') as launch:
            launch.return_value.pid=1234;runtime.start()
            self.assertEqual(launch.call_args.args[0],[str(Path(tmp)/'NapCatWinBootMain.exe')])
            self.assertNotIn('QQ.exe',launch.call_args.args[0])

    def test_prepare_disables_other_endpoints_even_when_ws_is_unchanged(self):
        connection={'url':'ws://127.0.0.1:3001/','token':'fixture-token'}
        config={'network':{}}
        def api(action,body=None):
            if action=='QQLogin/CheckLoginStatus':return {'isLogin':True}
            if action=='OB11Config/GetConfig':return config
            if action=='OB11Config/SetConfig':
                config.clear();config.update(json.loads(body['config']));return {}
            raise AssertionError(action)
        with patch.object(runtime,'api',side_effect=api),patch('qq_settings.connection_settings',return_value=connection):
            runtime.prepare()
            config['network']['httpClients']=[{'enable':True,'url':'https://external.invalid'}]
            runtime.prepare()
        self.assertEqual(config['network']['httpClients'],[])
        self.assertEqual(len(config['network']['websocketServers']),1)

    def test_status_does_not_report_old_worker_as_listening_after_stop(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(runtime,'DATA',Path(tmp)),patch.object(runtime,'paths',return_value={'port':6099}),patch.object(runtime,'available',return_value=True),patch.object(runtime,'api',side_effect=[{'isLogin':True},{'uin':'100001','nick':'Fixture'}]):
            folder=Path(tmp)/'qq';folder.mkdir()
            (Path(tmp)/'config.json').write_text(json.dumps({'enabled':False,'run_id':'new-run'}),encoding='utf8')
            (folder/'state.json').write_text(json.dumps({'state':'listening','detail':'old listening','runId':'old-run','bot':'100001'}),encoding='utf8')
            result=runtime.status()
            self.assertTrue(result['loggedIn'])
            self.assertEqual(result['worker']['state'],'stopped')

    def test_webui_reuses_encrypted_session_and_refreshes_only_when_unauthorized(self):
        import threading
        from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
        auth={'calls':0,'valid':'fixture-credential','limited':False}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length',0)))
                if self.path=='/api/auth/login':
                    auth['calls']+=1
                    result={'code':-1,'message':'login rate limit'} if auth['limited'] else {'code':0,'data':{'Credential':auth['valid']}}
                elif self.headers.get('Authorization')!='Bearer '+auth['valid']:
                    result={'code':-1,'message':'Unauthorized'}
                elif self.path.endswith('BusinessFailure'):result={'code':-1,'message':'operation failed'}
                else:result={'code':0,'data':{'isLogin':True}}
                raw=json.dumps(result).encode();self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp,patch.object(runtime,'DATA',Path(tmp)),patch.object(runtime,'paths',return_value={'port':server.server_port}):
                file=Path(tmp)/'qq/webui.dpapi';file.parent.mkdir();file.write_bytes(runtime.protect(b'fixture-webui-token'))
                for _ in range(12):self.assertTrue(runtime.api('QQLogin/CheckLoginStatus')['isLogin'])
                self.assertEqual(auth['calls'],1)
                self.assertNotIn(b'fixture-credential',(Path(tmp)/'qq/webui-session.dpapi').read_bytes())
                auth['valid']='rotated-credential'
                self.assertTrue(runtime.api('QQLogin/CheckLoginStatus')['isLogin'])
                self.assertEqual(auth['calls'],2)
                with self.assertRaises(ValueError):runtime.api('QQLogin/BusinessFailure')
                self.assertEqual(auth['calls'],2)
                auth['valid']='next-credential';auth['limited']=True
                with self.assertRaises(ValueError):runtime.api('QQLogin/CheckLoginStatus')
                with self.assertRaises(ValueError):runtime.api('QQLogin/CheckLoginStatus')
                self.assertEqual(auth['calls'],3)
        finally:server.shutdown();server.server_close();thread.join(timeout=2)

if __name__=='__main__':unittest.main()
