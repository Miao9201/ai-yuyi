from pathlib import Path
import hashlib
import tempfile
import unittest
from unittest.mock import patch
import qq_settings as qq
import qq_context as context
from companion_memory import Knowledge


class QQContextTests(unittest.TestCase):
    def test_generic_image_request_can_use_allowed_stickers_but_specific_photos_do_not(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'catalog.json'
            file.write_text(json.dumps({'items':[
                {'id':'happy','kind':'emoji','caption':'开心表情','tags':['开心'],'uses':1,'safe_auto':True},
                {'id':'blocked','kind':'emoji','caption':'不允许','uses':100,'allowed':False}]}),encoding='utf8')
            for question in ('发点图片给我看','发张图','给我来张图片'):
                result=context.media_options(question,[],file)
                self.assertEqual(result['intent'],'emoji');self.assertEqual([i['id'] for i in result['candidates']],['happy'])
            for question in ('发张你的自拍','发张以前画画的照片','不要发图片'):
                self.assertEqual(context.media_options(question,[],file)['candidates'],[],question)
            catalog=json.loads(file.read_text());catalog['items'].append({'id':'drawing','kind':'image','caption':'画画的作品','tags':['画画'],'uses':1})
            file.write_text(json.dumps(catalog),encoding='utf8')
            self.assertEqual(context.media_options('发点图片给我看',[],file)['candidates'][0]['id'],'drawing')

    def test_cli_reads_complete_retained_history_without_truncating_json(self):
        import io,json,runpy,contextlib
        from types import SimpleNamespace
        profile={'name':'体验角色','real_chat_knowledge':False,'media_catalog':None}
        role=SimpleNamespace(profile=profile,facts=lambda:'体验角色')
        body={'bot':'300001','kind':'private','peer':'100001','persona':'linmuwan','text':'你好',
              'history':[{'key':str(i),'text':'长'*4000,'answer':'收到','phase':'sent','at':1} for i in range(100)]}
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)),patch('persona.load_profile',return_value=profile),patch('persona.Persona',return_value=role):
            qq.save_config({'persona':'linmuwan','groupPersona':'linmuwan','privateUsers':['100001']})
            output=io.StringIO()
            with patch('sys.stdin',io.StringIO(json.dumps(body,ensure_ascii=False))),contextlib.redirect_stdout(output):
                runpy.run_module('qq_context',run_name='__main__')
            self.assertIn('context',json.loads(output.getvalue()))
            file=next((Path(tmp)/'qq/memories').glob('*.sqlite3'))
            knowledge=Knowledge(file)
            try:self.assertEqual(knowledge.db.execute("SELECT COUNT(*) FROM memories WHERE origin='live'").fetchone()[0],100)
            finally:knowledge.close()

    def test_scope_requires_exact_allowed_peer_and_persona(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            qq.save_config({'persona':'linmuwan','groupPersona':'linmuwan','privateUsers':['100001'],'groups':['200001']})
            with patch.object(context,'load_profile',return_value={'name':'体验角色','real_chat_knowledge':False}):
                good=context.resolve_scope('300001','private','100001','linmuwan')
                other=context.resolve_scope('300001','group','200001','linmuwan')
                self.assertNotEqual(good['file'],other['file']);self.assertNotEqual(good['uid'],other['uid'])
                self.assertIn('qq:',good['uid'])
                for args in [('300001','private','100002','linmuwan'),('300001','group','200002','linmuwan'),('300001','group','200001','private_example'),('300001','private','100001','../example')]:
                    with self.assertRaises(ValueError):context.resolve_scope(*args)
            qq.save_config({'persona':'linmuwan','groupPersona':'linmuwan','groups':[]})
            with self.assertRaises(ValueError):context.resolve_scope('300001','group','200001','linmuwan')

    def test_group_cannot_load_private_profile_even_if_title_is_public(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            qq.save_config({'persona':'linmuwan','groupPersona':'linmuwan','groups':['200001']})
            with patch.object(context,'load_profile',return_value={'name':'体验角色','real_chat_knowledge':True}):
                with self.assertRaises(ValueError):context.resolve_scope('300001','group','200001','linmuwan')

    def test_import_reference_filters_out_other_platform_live_and_manual_records_without_writing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'import.sqlite3';k=Knowledge(file)
            k.put('export:1','export','2026-01-01','2026-01-01','画画，原始导入内容',['e1'])
            k.put('live:wx','live','2026-01-01','2026-01-01','画画，WX_PRIVATE_SENTINEL',['wx1'])
            k.put('manual:wx','manual','2026-01-01','2026-01-01','画画，WX_MANUAL_SENTINEL',['wm1'])
            k.db.execute("INSERT INTO pairs(question,answer,at,source_ids) VALUES(?,?,?,?)",('画画','IMPORTED_STYLE','2026-01-01','["e1"]'))
            k.db.execute("INSERT INTO pairs(question,answer,at,source_ids) VALUES(?,?,?,?)",('画画','WX_STYLE_SENTINEL','2026-01-01','["wx1"]'))
            k.db.commit();k.close();before=hashlib.sha256(file.read_bytes()).hexdigest()
            view=context.ImportedKnowledge(file)
            try:
                self.assertEqual([r['origin'] for r in view.db.execute('SELECT origin FROM memories')],['export'])
                self.assertEqual([r['origin'] for r in view.search('画画')],['export'])
                self.assertEqual([r['answer'] for r in view.db.execute('SELECT answer FROM pairs')],['IMPORTED_STYLE'])
                with self.assertRaises(Exception):view.db.execute("INSERT INTO main.meta VALUES('bad','write')")
            finally:view.close()
            self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(),before)

    def test_memory_editor_uses_qq_scope_without_reading_wechat_credentials(self):
        import memory_editor
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)):
            qq.save_config({'persona':'linmuwan','groupPersona':'linmuwan','privateUsers':['100001']})
            (Path(tmp)/'qq/state.json').write_text('{"bot":"300001"}',encoding='utf8')
            with patch.object(context,'load_profile',return_value={'name':'体验角色','real_chat_knowledge':False}),patch.object(memory_editor,'load_credential',side_effect=AssertionError('QQ must not use WeChat auth')):
                body={'account':'qq:300001:private:100001','persona':'linmuwan','text':'我喜欢画画'}
                added=memory_editor.execute('add',body)['entry']
                self.assertEqual(added['text'],'我喜欢画画')
                listed=memory_editor.execute('list',body)
                self.assertEqual(listed['total'],1)


    def test_group_context_replaces_private_relationship_instructions(self):
        from types import SimpleNamespace
        profile={'name':'体验角色','real_chat_knowledge':False,'media_catalog':None}
        role=SimpleNamespace(profile=profile,facts=lambda:'PRIVATE_RELATIONSHIP_SENTINEL')
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq,'DATA',Path(tmp)),patch.object(context,'load_profile',return_value=profile),patch.object(context,'Persona',return_value=role):
            qq.save_config({'persona':'linmuwan','groupPersona':'linmuwan','groups':['200001']})
            result=context.context_for({'bot':'300001','kind':'group','peer':'200001','persona':'linmuwan','text':'你好','history':[]})
            self.assertIn('普通群友',result['context'])
            self.assertNotIn('PRIVATE_RELATIONSHIP_SENTINEL',result['context'])

if __name__=='__main__':unittest.main()
