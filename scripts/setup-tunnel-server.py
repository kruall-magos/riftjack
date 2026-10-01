"""Run by setup-tunnel.py over SSH with sudo; never receives a private key."""
import base64
import datetime
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def configure(public_key):
    if os.geteuid() != 0 or not sys.platform.startswith('linux'):
        raise RuntimeError('This setup requires sudo/root on a Linux Synapse server.')
    words = public_key.strip().split()
    if len(words) < 2 or words[0] != 'ssh-ed25519':
        raise RuntimeError('Expected an Ed25519 public key.')
    base64.b64decode(words[1], validate=True)
    sshd = shutil.which('sshd') or '/usr/sbin/sshd'
    config = Path('/etc/ssh/sshd_config')
    run([sshd, '-t'])  # Refuse to modify an already-invalid configuration.
    # Determine the active service before changing anything.
    service = next((name for name in ('ssh', 'sshd') if subprocess.run(
        ['systemctl', 'is-active', '--quiet', name]).returncode == 0), None)
    if service is None:
        raise RuntimeError('No active systemd ssh/sshd service found; no changes made.')
    name = 'matrix-tunnel'
    marker = Path('/var/lib/matrix-connector-tunnel/managed-user')
    try:
        account = pwd.getpwnam(name)
        if not marker.exists():
            raise RuntimeError('matrix-tunnel already exists and was not created by this script; refusing to change it.')
    except KeyError:
        # An impossible password hash disables password login without locking public-key login.
        run(['useradd', '--create-home', '--shell', '/bin/sh', '--password', '*', name])
        marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        marker.write_text('matrix-connector\n')
        marker.chmod(0o600)
        account = pwd.getpwnam(name)
    ssh_dir = Path(account.pw_dir) / '.ssh'
    if ssh_dir.is_symlink():
        raise RuntimeError('Refusing a symlinked .ssh directory.')
    ssh_dir.mkdir(mode=0o700, exist_ok=True)
    os.chown(ssh_dir, account.pw_uid, account.pw_gid)
    ssh_dir.chmod(0o700)
    keys = ssh_dir / 'authorized_keys'
    if keys.is_symlink():
        raise RuntimeError('Refusing symlinked authorized_keys.')
    line = 'restrict,port-forwarding,permitopen="127.0.0.1:8008",command="/bin/false" ' + ' '.join(words[:2]) + ' matrix-connector-tunnel'
    existing = keys.read_text().splitlines() if keys.exists() else []
    # Replace entries for this public key only; preserve other entries.
    existing = [entry for entry in existing if words[1] not in entry.split()]
    keys.write_text('\n'.join(existing + [line]) + '\n')
    os.chown(keys, account.pw_uid, account.pw_gid)
    keys.chmod(0o600)

    begin = '# BEGIN matrix-connector tunnel user'
    end = '# END matrix-connector tunnel user'
    original = config.read_text()
    if original.count(begin) != original.count(end) or original.count(begin) > 1:
        raise RuntimeError('Unexpected existing tunnel configuration markers.')
    cleaned = original
    if begin in original:
        start = original.index(begin)
        finish = original.index(end, start) + len(end)
        cleaned = original[:start] + original[finish:]
    block = f'''{begin}
Match User matrix-tunnel
    PubkeyAuthentication yes
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthenticationMethods publickey
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:8008
    AllowStreamLocalForwarding no
    PermitTunnel no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    ForceCommand /bin/false
Match all
{end}
'''
    backup = config.with_name('sshd_config.matrix-backup-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    shutil.copy2(config, backup)
    try:
        config.write_text(cleaned.rstrip() + '\n\n' + block)
        run([sshd, '-t'])
        effective = run([sshd, '-T', '-C', 'user=matrix-tunnel,host=localhost,addr=127.0.0.1'],
                        capture_output=True, text=True).stdout
        required = ('allowtcpforwarding local', 'permitopen 127.0.0.1:8008',
                    'allowstreamlocalforwarding no', 'permittunnel no',
                    'forcecommand /bin/false', 'authenticationmethods publickey',
                    'passwordauthentication no', 'permittty no')
        if any(value not in effective.splitlines() for value in required):
            raise RuntimeError('Earlier SSH rules override tunnel restrictions; configuration restored.')
        run(['systemctl', 'reload', service])
    except BaseException:
        shutil.copy2(backup, config)
        run([sshd, '-t'])
        run(['systemctl', 'reload', service])
        raise
    print('Tunnel user configured. SSH configuration backup:', backup)


if __name__ == '__main__':
    configure(base64.b64decode(sys.argv[1], validate=True).decode('ascii'))
