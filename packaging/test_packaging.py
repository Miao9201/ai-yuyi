import importlib.util
import hashlib
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
import zipfile
from unittest.mock import patch, Mock

APP = Path(__file__).resolve().parents[1]
WEBVIEW = Path(os.environ.get('YUYI_TEST_WEBVIEW_RUNTIME', str(APP/'runtime/webview2')))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class PackagingTests(unittest.TestCase):
    def test_launcher_does_not_attach_to_another_installation_on_reused_port(self):
        runtime = module('runtime_paths_test', APP/'runtime_paths.py')
        with patch.dict(sys.modules, {'settings':types.SimpleNamespace(DATA=APP/'data'),'v12_bridge':types.SimpleNamespace(UPSTREAM=APP/'upstream-v1.2.0'),'runtime_paths':runtime}):
            launcher=module('launcher_identity_test',APP/'launcher.py')
        own=hashlib.sha256(os.path.normcase(str(APP.resolve())).encode('utf-8')).hexdigest()
        for identity,expected in ((own,True),('other-installation',False),(None,False)):
            response=io.BytesIO(json.dumps({'appId':'ai-yuyi','instanceId':identity}).encode())
            with patch.object(launcher.urllib.request,'urlopen',return_value=response) as fetch:
                self.assertEqual(launcher.ours('http://127.0.0.1:7788'),expected)
                fetch.assert_called_once_with('http://127.0.0.1:7788/api/health',timeout=1)

    def test_manifest_allows_only_reviewed_unchanged_files(self):
        builder = module('portable_builder', APP / 'packaging' / 'build_portable.py')
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory).resolve()
            (source / '.clean-release-source').touch()
            script = source / 'launcher.py'
            script.write_text('print(1)', encoding='utf-8')
            marker = source / 'PUBLIC-SOURCE-MANIFEST.json'
            marker.write_text(json.dumps({'files': {'launcher.py': builder.digest(script)}}), encoding='utf-8')
            self.assertEqual(len(builder.source_files(source)), 1)
            script.write_text('changed', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'changed after review'):
                builder.source_files(source)
            for name in ('../outside', 'C:/outside', 'data/api-key.dpapi', 'private/history.json', 'data/accounts.json','dist/package.exe','build/source.py','state.sqlite3','.env.local'):
                marker.write_text(json.dumps({'files': {name: 'irrelevant'}}), encoding='utf-8')
                with self.assertRaises(ValueError):
                    builder.source_files(source)

    def test_runtime_prefers_bundled_with_empty_path(self):
        runtime = module('runtime_paths_test', APP / 'runtime_paths.py')
        with tempfile.TemporaryDirectory() as directory, patch.object(runtime, 'ROOT', Path(directory)), patch.object(runtime.shutil, 'which', return_value=None):
            root = Path(directory)
            for relative in ('runtime/node/node.exe', 'runtime/python/python.exe', 'runtime/python/pythonw.exe'):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            self.assertEqual(runtime.node_executable(), str(root / 'runtime/node/node.exe'))
            self.assertEqual(runtime.python_executable(), str(root / 'runtime/python/python.exe'))
            self.assertEqual(runtime.python_executable(True), str(root / 'runtime/python/pythonw.exe'))
            (root / 'runtime/node/node.exe').unlink()
            with self.assertRaisesRegex(RuntimeError, 'Node.js'):
                runtime.node_executable()

    def test_launcher_recovers_corrupt_saved_state_and_skips_busy_port(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / 'data'
            data.mkdir()
            (data / 'console.json').write_text('[broken', encoding='utf-8')
            fake_settings = types.SimpleNamespace(DATA=data)
            fake_bridge = types.SimpleNamespace(UPSTREAM=root / 'upstream')
            runtime = module('runtime_paths_test', APP / 'runtime_paths.py')
            with patch.dict(sys.modules, {'settings': fake_settings, 'v12_bridge': fake_bridge, 'runtime_paths': runtime}):
                launcher = module('launcher_test', APP / 'launcher.py')
            socket = Mock()
            socket.__enter__ = Mock(return_value=socket)
            socket.__exit__ = Mock(return_value=False)
            socket.bind.side_effect = [OSError('busy'), None]
            child = Mock(pid=123)
            with patch.object(launcher.socket, 'socket', return_value=socket), patch.object(launcher, 'node_executable', return_value='bundled-node'), patch.object(launcher, 'python_executable', return_value='bundled-python'), patch.object(launcher.subprocess, 'Popen', return_value=child) as spawn, patch.object(launcher, 'ours', return_value=True), patch.object(launcher, 'open_console') as browser:
                self.assertEqual(launcher.main(open_browser=False), 'http://127.0.0.1:7789')
                browser.assert_not_called()
                self.assertEqual(spawn.call_args.args[0][0], 'bundled-node')
                self.assertEqual(spawn.call_args.kwargs['env']['WX_DESKTOP_PYTHON'], 'bundled-python')
                self.assertTrue((root / 'upstream/data').is_dir())

    def test_open_console_uses_desktop_window_and_preserves_requested_tab(self):
        runtime = module('runtime_paths_test', APP / 'runtime_paths.py')
        with patch.dict(sys.modules, {'settings': types.SimpleNamespace(DATA=Path('unused')), 'v12_bridge': types.SimpleNamespace(UPSTREAM=Path('unused')), 'runtime_paths': runtime}):
            launcher = module('launcher_test', APP / 'launcher.py')
        with tempfile.TemporaryDirectory() as directory, patch.object(launcher, '__file__', str(Path(directory)/'launcher.py')), patch.object(launcher, 'webbrowser', types.SimpleNamespace(open=Mock(return_value=True)), create=True), patch.object(launcher.subprocess, 'Popen') as spawn:
            (Path(directory)/'语忆AI.exe').touch()
            launcher.open_console('http://127.0.0.1:7788')
            spawn.assert_called_once()
            self.assertTrue(spawn.call_args.args[0][0].endswith('语忆AI.exe'))
            self.assertEqual(spawn.call_args.args[0][1:], ['--url', 'http://127.0.0.1:7788'])
            spawn.reset_mock()
            launcher.open_console('http://127.0.0.1:7788/#api')
            self.assertEqual(spawn.call_args.args[0][1:], ['--url', 'http://127.0.0.1:7788/#api'])


@unittest.skipUnless(os.name == 'nt', 'Native Windows installer test')
class NativeInstallerTests(unittest.TestCase):
    def test_powershell_51_wrapper_omits_empty_optional_cache_argument(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            fake=root/'fake-python.cs'
            fake.write_text('using System.IO;class Fake {static int Main(string[] args) {File.WriteAllLines("argument-proof.txt",args);return 0;}}',encoding='utf-8')
            executable=root/'fake-python.exe';self.compile(fake,executable,'/target:exe')
            subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(APP/'packaging/build-portable.ps1'),'-SourceRoot',str(root/'source'),'-OutputRoot',str(root/'dist'),'-PythonExecutable',str(executable),'-NodeExecutable','node'],cwd=root,check=True,capture_output=True)
            args=(root/'argument-proof.txt').read_text(encoding='utf-8-sig').splitlines()
            self.assertNotIn('--cache',args)
            self.assertEqual(args[:2],['-X','utf8'])
            self.assertIn('--source',args);self.assertIn('--node',args)

    def compile(self, source, output, *arguments):
        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        references=[]
        if source.name=='desktop-launcher.cs':
            references=['/platform:x64','/reference:System.Drawing.dll','/reference:System.Core.dll',*['/reference:'+str(WEBVIEW/name) for name in ('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll')]]
        subprocess.run([str(compiler), '/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/out:' + str(output), *references, *arguments, str(source)], check=True, capture_output=True)

    def test_offline_install_upgrade_and_zip_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'payload.zip'
            with zipfile.ZipFile(archive, 'w') as payload:
                payload.writestr('data/config.json', '{"default":true}')
                payload.writestr('program.txt', 'new program')
                payload.writestr('语忆AI.exe', 'new launcher')
                payload.writestr('upstream-v1.2.0/personas/linmuwan.md', 'default role')
            executable = root / 'Setup.exe'
            self.compile(APP / 'packaging/installer.cs', executable, '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', '/resource:' + str(archive) + ',payload.zip')
            target = root / 'installed'
            command = [str(executable), '/quiet', '/target', str(target), '/no-launch', '/no-shortcut']
            subprocess.run(command, check=True)
            (target / 'data/config.json').write_text('personal settings', encoding='utf-8')
            (target / 'program.txt').write_text('old program', encoding='utf-8')
            (target / 'AI语忆.exe').write_text('old launcher', encoding='utf-8')
            private = target / 'private' / 'sample'
            private.mkdir(parents=True)
            (private / 'memory.json').write_text('private memory', encoding='utf-8')
            persona = target / 'upstream-v1.2.0/personas/linmuwan.md'
            persona.write_text('user edited role', encoding='utf-8')
            subprocess.run(command, check=True)
            self.assertEqual((target / 'data/config.json').read_text(encoding='utf-8'), 'personal settings')
            self.assertEqual((target / 'program.txt').read_text(encoding='utf-8'), 'new program')
            self.assertEqual(persona.read_text(encoding='utf-8'), 'user edited role')
            self.assertEqual((target / 'AI语忆.exe').read_text(encoding='utf-8'), 'new launcher')
            self.assertEqual((private / 'memory.json').read_text(encoding='utf-8'), 'private memory')
            with zipfile.ZipFile(archive, 'w') as payload:
                payload.writestr('would-be-written.txt', 'reject before writing')
                payload.writestr('../escaped.txt', 'bad')
            malicious = root / 'BadSetup.exe'
            self.compile(APP / 'packaging/installer.cs', malicious, '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', '/resource:' + str(archive) + ',payload.zip')
            result = subprocess.run([str(malicious), *command[1:]], check=False)
            self.assertEqual(result.returncode, 1)
            log = target / 'install-error.log'
            self.assertTrue(log.is_file(), 'Quiet installer failures must retain diagnostic details')
            self.assertIn('InvalidDataException', log.read_text(encoding='utf-8-sig'))
            self.assertFalse((root / 'escaped.txt').exists())
            self.assertFalse((target / 'would-be-written.txt').exists())

    def test_native_launcher_uses_relative_runtime_without_python_in_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / 'runtime/python'
            runtime.mkdir(parents=True)
            (root / 'launcher.py').write_text('# entry script', encoding='utf-8')
            fake_python = root / 'fake-python.cs'
            fake_python.write_text('using System;using System.IO;class Fake {static int Main(string[] args) {File.WriteAllText("runtime-proof.txt",String.Join("|",args));return 0;}}', encoding='utf-8')
            self.compile(fake_python, runtime / 'python.exe')
            shutil.copytree(WEBVIEW,root/'runtime/webview2')
            executable = root / '语忆AI.exe'
            self.compile(APP / 'desktop-launcher.cs', executable)
            env = os.environ.copy()
            env['PATH'] = str(Path(os.environ['WINDIR']) / 'System32')
            result=subprocess.run([str(executable), '--no-dialog'], check=False, env=env, timeout=20)
            self.assertEqual(result.returncode,1,'Reject invalid backend URL instead of opening an external page')
            self.assertIn(str(root / 'launcher.py'), (root / 'runtime-proof.txt').read_text(encoding='utf-8-sig'))
            self.assertIn('--console-url',(root/'runtime-proof.txt').read_text(encoding='utf-8-sig'))

    def test_native_url_validation_blocks_remote_and_unexpected_local_addresses(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            probe=root/'probe.cs'
            probe.write_text('''using System; class Probe { static int Main() {
                foreach(string url in new[]{"https://example.com/","file:///C:/data","http://127.0.0.1:80/","http://localhost:7788/","http://127.0.0.1:7788/api/state","http://user@127.0.0.1:7788/"}) {
                    bool rejected=false;try{DesktopLauncher.ValidateUrl(url);}catch{rejected=true;}if(!rejected)return 1;
                }
                if(DesktopLauncher.ValidateUrl("http://127.0.0.1:7788/#api")!="http://127.0.0.1:7788/#api")return 2;
                return 0;
            }}''',encoding='utf-8')
            target=root/'probe.exe'
            self.compile(APP/'desktop-launcher.cs',target,'/main:Probe',str(probe))
            subprocess.run([str(target)],check=True,timeout=10)


if __name__ == '__main__':
    unittest.main()
