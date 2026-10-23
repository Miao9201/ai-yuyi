import unittest
from unittest.mock import Mock,patch
from ilink_bot import WorkerPool
from qq_bot import QQWorker

class QQSupervisorTests(unittest.TestCase):
    def test_wechat_can_be_disabled_without_changing_default_primary_behavior(self):
        proc=Mock();proc.poll.return_value=None
        spawn=Mock(return_value=proc);pool=WorkerPool(spawn,lambda _: {})
        pool.reconcile([],primary_enabled=False);spawn.assert_not_called()
        pool.reconcile([]);spawn.assert_called_once_with('','')
        pool.reconcile([],primary_enabled=False);proc.terminate.assert_called_once()

    def test_qq_stops_on_disable_and_backs_off_after_failed_spawn(self):
        proc=Mock();proc.poll.return_value=None
        spawn=Mock(side_effect=[OSError('unavailable'),proc]);worker=QQWorker(spawn)
        with patch('qq_bot.time.monotonic',return_value=10):worker.reconcile(True);worker.reconcile(True)
        self.assertEqual(spawn.call_count,1)
        with patch('qq_bot.time.monotonic',return_value=21):worker.reconcile(True)
        self.assertIs(worker.proc,proc);worker.reconcile(False);proc.terminate.assert_called_once()

    def test_bad_platform_config_keeps_last_known_platform_switches(self):
        import json,tempfile
        from pathlib import Path
        import qq_settings
        from ilink_bot import platform_config
        with tempfile.TemporaryDirectory() as tmp,patch.object(qq_settings,'DATA',Path(tmp)):
            qq_settings.save_config({'enabled':True,'wechatEnabled':False})
            good=platform_config({'wechatEnabled':False,'enabled':False})
            (Path(tmp)/'qq/settings.json').write_text('bad json',encoding='utf8')
            result=platform_config(good)
            self.assertTrue(result['enabled'])
            self.assertFalse(result['wechatEnabled'])

if __name__=='__main__':unittest.main()
