import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import qq_settings as qq


class QQSettingsTests(unittest.TestCase):
    def test_hour_slots_are_optional_validated_and_persist_without_changing_other_settings(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            self.assertIsNone(qq.load_config()['activeHourSlots'])
            saved=qq.save_config({'activeHourSlots':[23,0,7],'privateUsers':['100001']})
            self.assertEqual(saved['activeHourSlots'],[0,7,23])
            self.assertEqual(qq.save_config({'probability':0.2})['activeHourSlots'],[0,7,23])
            self.assertEqual(qq.save_config({'activeHourSlots':[]})['activeHourSlots'],[])
            for invalid in ([24],[-1],[True],[1.5],['7'],[1,1],list(range(25)),False):
                before=(Path(tmp)/'qq/settings.json').read_bytes()
                with self.assertRaises(ValueError,msg=str(invalid)):qq.save_config({'activeHourSlots':invalid})
                self.assertEqual((Path(tmp)/'qq/settings.json').read_bytes(),before)

    def test_legacy_private_profile_cannot_follow_into_group(self):
        import persona
        legacy=persona.PRIVATE.name
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)/'data'),patch.object(persona,'DATA',Path(tmp)/'data'),patch.object(persona,'PROFILE',Path(tmp)/'data/persona-profile.json'),patch.object(persona,'PROFILE_DIR',Path(tmp)/'data/persona-profiles'):
            root=Path(tmp);(root/'data').mkdir();(root/'data/persona-profile.json').write_text('{"real_chat_knowledge":true}')
            role=root/'upstream-v1.2.0/personas'/f'{legacy}.md';role.parent.mkdir(parents=True);role.write_text('fixture')
            with self.assertRaises(ValueError):qq.save_config({'persona':legacy,'groupFollowsDefault':True})

    def test_unified_default_updates_group_but_preserves_explicit_assignments(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            cfg=qq.load_config();self.assertTrue(cfg['groupFollowsDefault'])
            changed=qq.save_config({'persona':'linmuwan','privateUsers':['100001'],'privatePersonas':{'100001':'private_fixture'}})
            self.assertEqual(changed['groupPersona'],'linmuwan');self.assertEqual(changed['privatePersonas']['100001'],'private_fixture')
            qq.save_config({'groupFollowsDefault':False,'groupPersona':'dafeiyu'})
            self.assertEqual(qq.save_config({'persona':'linmuwan'})['groupPersona'],'dafeiyu')
            with self.assertRaises(ValueError):qq.save_config({'persona':'private_fixture','groupFollowsDefault':True})

    def test_old_different_group_role_stays_separate_when_loading_and_editing(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            file=Path(tmp)/'qq/settings.json';file.parent.mkdir();file.write_text('{"persona":"linmuwan","groupPersona":"dafeiyu"}',encoding='utf8')
            self.assertFalse(qq.load_config()['groupFollowsDefault'])
            self.assertEqual(qq.save_config({'probability':0.2})['groupPersona'],'dafeiyu')

    def test_missing_custom_group_role_does_not_block_configuration_recovery(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)/'data'),patch('persona.load_profile',return_value={'real_chat_knowledge':False}):
            role=Path(tmp)/'upstream-v1.2.0/personas/public_fixture.md';role.parent.mkdir(parents=True);role.write_text('fixture')
            qq.save_config({'groupPersona':'public_fixture'});role.unlink()
            self.assertEqual(qq.load_config()['groupPersona'],'public_fixture')
            self.assertEqual(qq.save_config({'groupPersona':'dafeiyu'})['groupPersona'],'dafeiyu')
            self.assertFalse(qq.save_config({'wechatEnabled':False})['wechatEnabled'])

    def test_default_role_and_independent_reply_parameters_are_validated(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            cfg=qq.load_config();self.assertEqual(cfg['persona'],'dafeiyu');self.assertEqual(cfg['probability'],0.1)
            self.assertEqual(cfg['groupPersona'],'dafeiyu')
            saved=qq.save_config({'activeHours':[9,23],'replyOptions':{'visionEnabled':False,'sceneEnabled':True,'emotionEnabled':True}})
            self.assertFalse(saved['replyOptions']['visionEnabled'])
            for bad in ({'activeHours':[25,2]},{'emotionAware':'yes'},{'replyOptions':{'apiKey':'bad'}},{'replyOptions':{'visionEnabled':'no'}}):
                with self.assertRaises(ValueError):qq.save_config(bad)

    def test_new_install_has_no_allowed_targets_and_qq_is_off(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            cfg=qq.load_config()
            self.assertFalse(cfg['enabled']);self.assertTrue(cfg['wechatEnabled'])
            self.assertEqual(cfg['privateUsers'],[]);self.assertEqual(cfg['groups'],[])

    def test_invalid_target_or_remote_endpoint_does_not_change_settings(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            qq.save_config({'privateUsers':['100001'],'groups':['200001']})
            before=(Path(tmp)/'qq/settings.json').read_bytes()
            for body in ({'groups':['../200001']},{'enabled':'false'},{'wsUrl':'ws://example.com:3001/'},{'wsUrl':'ws://127.0.0.1:3001/?access_token=secret'},{'probability':2},{'groupPersona':'private_example'},{'privatePersonas':{'999999':'private_example'}}):
                with self.assertRaises(ValueError,msg=str(body)):qq.save_config(body)
                self.assertEqual((Path(tmp)/'qq/settings.json').read_bytes(),before)

    def test_connection_token_is_encrypted_and_not_in_public_config(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            first=qq.connection_settings();second=qq.connection_settings()
            self.assertEqual(first['token'],second['token']);self.assertGreater(len(first['token']),30)
            self.assertNotIn(first['token'].encode(),(Path(tmp)/'qq/connection.dpapi').read_bytes())
            self.assertNotIn(first['token'],json.dumps(qq.public_config()))


    def test_removing_private_target_also_removes_its_persona_assignment(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            qq.save_config({'privateUsers':['100001','100002'],'privatePersonas':{'100001':'private_example'}})
            result=qq.save_config({'privateUsers':['100002']})
            self.assertEqual(result['privateUsers'],['100002'])
            self.assertEqual(result['privatePersonas'],{})

if __name__=='__main__':unittest.main()
