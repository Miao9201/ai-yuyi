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

if __name__=='__main__':unittest.main()
