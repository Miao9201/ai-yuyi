import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
import import_persona as importer
import companion_memory as memory
import persona


class ImportPersonaTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.data=self.root/'data';self.data.mkdir()
        for module in (importer,memory,persona):
            p=patch.object(module,'DATA',self.data);p.start();self.addCleanup(p.stop)
        self.export=self.root/'export';(self.export/'media').mkdir(parents=True)
        Image.new('RGB',(8,8),'purple').save(self.export/'media/art.png')
        self.messages=[
            {'id':'1','kind':'text','sender_id':'owner-fixture','sender_name':'朋友甲','text':'你记得月亮画展吗','sent_at':'2025-06-01T20:00:00+08:00'},
            {'id':'2','kind':'text','sender_id':'target-fixture','sender_name':'示例角色','text':'记得呀，月亮画展那天我们看了紫色的画','sent_at':'2025-06-01T20:01:00+08:00'},
            {'id':'3','kind':'image','sender_id':'target-fixture','sender_name':'示例角色','refs':[{'kind':'image','uri':'media/art.png'}],'sent_at':'2025-06-01T20:02:00+08:00'},
        ]
        self.source=self.export/'messages.json';self.source.write_text(json.dumps({'messages':self.messages}),encoding='utf-8')
        self.original=hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.body={'source':str(self.source),'target':'target-fixture','self':'owner-fixture','persona':'sample_import','relationship':'好朋友'}

    def test_import_retrieves_style_memory_and_media_without_touching_source(self):
        participants=importer.analyze(self.source)['participants']
        self.assertEqual({p['id'] for p in participants},{'owner-fixture','target-fixture'})
        result=importer.import_persona({**self.body,'allow_media':True})
        self.assertEqual(result['indexed_messages'],2);self.assertEqual(result['pairs'],1)
        self.assertEqual(result['image_assets'],1)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(),self.original)
        p=persona.load_profile('sample_import');self.assertEqual(p['name'],'示例角色')
        context=memory.context_for({'persona':'sample_import','owner':'test-owner','text':'月亮画展','history':[]})
        self.assertIn('紫色的画',context['context']);self.assertIn('【表达范例】',context['context'])
        self.assertEqual(context['evidence'][0]['origin'],'export')
        self.assertIn('AI风格模拟',context['context'])
        catalog=self.root/'private/sample_import/media-catalog.json'
        choices=memory.media_options('发张月亮画展的图',[],catalog)
        self.assertEqual(len(choices['candidates']),1)
        db=memory.Knowledge(self.root/'private/sample_import/memory.sqlite3')
        try:self.assertEqual(db.editor_list('memories',local_only=True)['total'],0)
        finally:db.close()

    def test_media_default_denied_existing_role_and_wrong_senders_rejected(self):
        importer.import_persona(self.body)
        catalog=self.root/'private/sample_import/media-catalog.json'
        self.assertEqual(memory.media_options('发张月亮画展的图',[],catalog)['candidates'],[])
        with self.assertRaises(ValueError):importer.import_persona(self.body)
        for changes in ({'persona':'../escape'},{'target':'missing'},{'self':'target-fixture'}):
            with self.assertRaises(ValueError):importer.import_persona({**self.body,**changes})

    def test_missing_reference_and_other_role_do_not_leak_imported_corpus(self):
        importer.import_persona(self.body)
        response=memory.context_for({'persona':'sample_import','owner':'test-owner','text':'火星飞船','history':[]})
        self.assertNotIn('紫色的画',response['context'])
        other=memory.context_for({'persona':'other_role','owner':'test-owner','text':'月亮画展','history':[]})
        self.assertNotIn('紫色的画',other['context'])


if __name__=='__main__':unittest.main()
