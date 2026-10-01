import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('tunnel_setup', Path(__file__).parents[1] / 'scripts/setup-tunnel-server.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class TunnelSetupTest(unittest.TestCase):
    def simulate(self, fail_validation=False):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        config = root / 'etc/ssh/sshd_config'
        config.parent.mkdir(parents=True)
        original = 'Port 22\nPasswordAuthentication yes\n'
        config.write_text(original)
        account = SimpleNamespace(pw_dir='/home/matrix-tunnel', pw_uid=1001, pw_gid=1001)
        (root / 'home/matrix-tunnel').mkdir(parents=True)
        created = False
        calls = []

        def user(name):
            if not created:
                raise KeyError(name)
            return account

        def run(args, **kwargs):
            nonlocal created
            calls.append(args)
            if args[0] == 'useradd':
                created = True
            if args[-1] == '-t' and fail_validation and '# BEGIN' in config.read_text():
                raise RuntimeError('bad SSH configuration')
            return SimpleNamespace(stdout='\n'.join([
                'allowtcpforwarding local', 'permitopen 127.0.0.1:8008',
                'allowstreamlocalforwarding no', 'permittunnel no', 'forcecommand /bin/false',
                'authenticationmethods publickey', 'passwordauthentication no', 'permittty no']))

        def local_path(value):
            return root / str(value).lstrip('/')

        with patch.object(setup, 'Path', local_path), patch.object(setup.os, 'geteuid', return_value=0), \
             patch.object(setup.os, 'chown'), patch.object(setup.sys, 'platform', 'linux'), \
             patch.object(setup.shutil, 'which', return_value='/usr/sbin/sshd'), \
             patch.object(setup.pwd, 'getpwnam', side_effect=user), patch.object(setup, 'run', side_effect=run), \
             patch.object(setup.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
            if fail_validation:
                with self.assertRaisesRegex(RuntimeError, 'bad SSH'):
                    setup.configure('ssh-ed25519 YWJj test')
                self.assertEqual(config.read_text(), original)
            else:
                setup.configure('ssh-ed25519 YWJj test')
                setup.configure('ssh-ed25519 YWJj test')
                self.assertEqual(config.read_text().count('# BEGIN matrix-connector'), 1)
                self.assertTrue(config.read_text().startswith(original))
                keys = root / 'home/matrix-tunnel/.ssh/authorized_keys'
                self.assertEqual(len(keys.read_text().splitlines()), 1)
                self.assertIn('permitopen="127.0.0.1:8008"', keys.read_text())
                self.assertEqual(keys.stat().st_mode & 0o777, 0o600)
                self.assertEqual(sum(args[0] == 'useradd' for args in calls), 1)
            self.assertIn(['systemctl', 'reload', 'ssh'], calls)
            self.assertFalse(any('restart' in args for args in calls))

    def test_setup_is_reentrant_and_restricts_only_the_dedicated_account(self):
        self.simulate()

    def test_invalid_sshd_config_is_restored_before_reload(self):
        self.simulate(fail_validation=True)

    def test_unmanaged_existing_user_is_not_modified(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(setup, 'Path', lambda value: Path(temp) / str(value).lstrip('/')), \
             patch.object(setup.os, 'geteuid', return_value=0), patch.object(setup.sys, 'platform', 'linux'), \
             patch.object(setup.pwd, 'getpwnam', return_value=SimpleNamespace()), \
             patch.object(setup, 'run') as run, \
             patch.object(setup.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                setup.configure('ssh-ed25519 YWJj test')
            self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
