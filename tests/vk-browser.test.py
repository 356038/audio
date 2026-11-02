"""Private GUI launch policy and secret handling; no real VK account."""
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('vk_browser', Path(__file__).resolve().parents[1] / 'scripts/vk-browser.py')
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)


class Checks(unittest.TestCase):
    def test_browser_ports_are_local_auth_required_and_chrome_sandbox_stays_enabled(self):
        commands=dict(browser.browser_commands('/private/authority', '/private/profile', '/private/password'))
        vnc=commands['VNC']
        self.assertEqual(vnc[vnc.index('-listen')+1], '127.0.0.1')
        self.assertEqual(vnc[vnc.index('-rfbauth')+1], '/private/password')
        self.assertIn('-localhost', vnc)
        self.assertIn('-no6', vnc)
        self.assertIn('127.0.0.1:6080', commands['web UI'])
        self.assertIn('127.0.0.1:5900', commands['web UI'])
        chrome=commands['Chrome']
        self.assertIn('/private/profile', chrome)
        self.assertTrue(any(arg.endswith('/vk-browser-driver.mjs') for arg in chrome))
        self.assertFalse(any('no-sandbox' in arg or 'remote-debugging' in arg or 'ignore-certificate' in arg for arg in chrome))
        self.assertIn('-auth', commands['display'])
        self.assertIn('-nolisten', commands['display'])

    def test_unit_is_non_root_temporary_and_isolated_from_player(self):
        args=browser.unit_command('/opt/wave/scripts/vk-browser.py')
        self.assertIn('--uid=wave-vk', args)
        self.assertIn('--gid=wave-vk', args)
        self.assertIn('--property=PrivateTmp=yes', args)
        self.assertIn('--property=ProtectSystem=strict', args)
        self.assertIn('--property=MemoryMax=1536M', args)
        self.assertIn('--property=RuntimeMaxSec=2h', args)
        self.assertIn('--property=UMask=0077', args)
        self.assertFalse(any('wave.service' in arg or '8787' in arg or '/etc/wave.env' in arg for arg in args))

    def test_private_file_rejects_world_readability_symlinks_and_directories(self):
        import os
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'password'
            file.write_bytes(b'fixture')
            file.chmod(0o600)
            browser.private_file(file, os.geteuid())
            file.chmod(0o644)
            with self.assertRaises(browser.SetupError):browser.private_file(file, os.geteuid())
            file.chmod(0o600)
            link=Path(directory)/'link'
            link.symlink_to(file)
            with self.assertRaises(browser.SetupError):browser.private_file(link, os.geteuid())
            with self.assertRaises(browser.SetupError):browser.private_file(Path(directory), os.geteuid())

    def test_child_login_logs_become_only_fixed_classifications(self):
        hints={}
        stream=io.BytesIO(b'https://login.example/?token=PRIVATE\nNo usable sandbox! PRIVATE\n')
        browser.collect_error(stream, hints, 'Chrome')
        self.assertEqual(hints, {'Chrome':'sandbox'})
        self.assertNotIn('PRIVATE', str(hints))
        self.assertTrue(stream.closed)

    def test_existing_unrelated_service_is_never_replaced(self):
        import subprocess
        for description in ['Other app', browser.UNIT]:
            with patch.object(browser.subprocess, 'run', return_value=subprocess.CompletedProcess([],0,stdout='LoadState=loaded\nDescription='+description+'\n')):
                with self.assertRaises(browser.SetupError):browser.check_unit()
        with patch.object(browser.subprocess, 'run', return_value=subprocess.CompletedProcess([],0,stdout='LoadState=not-found\nDescription='+browser.UNIT+'\n')):
            browser.check_unit()


if __name__ == '__main__':
    unittest.main()
