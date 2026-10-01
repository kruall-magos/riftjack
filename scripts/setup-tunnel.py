"""Interactive, one-time setup. SSH and sudo read passwords from the local terminal."""
import argparse
import base64
import http.client
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, help='SSH administrator login and host, e.g. admin@matrix.example.org')
    parser.add_argument('--port', type=int, default=22)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9_][a-zA-Z0-9_.-]*', args.target) or not 1 <= args.port <= 65535:
        parser.error('Expected user@hostname and a port from 1 to 65535.')
    if not sys.stdin.isatty():
        parser.error('Run this command in the Mac terminal so SSH/sudo can request passwords.')
    # The instance directory holds .env and data/; the server script ships with this code.
    root = Path(os.environ.get('RIFTJACK_HOME') or os.getcwd()).resolve()
    scripts = Path(__file__).resolve().parent
    if not (root / '.env').is_file():
        parser.error('Run this from the instance directory that contains .env, or set RIFTJACK_HOME.')
    key = root / 'data/ssh/matrix_tunnel_ed25519'
    public_key = Path(str(key) + '.pub').read_text()
    if not key.is_file():
        raise RuntimeError('Local private key is missing.')
    server_code = (scripts / 'setup-tunnel-server.py').read_bytes()
    payload = base64.b64encode(server_code).decode('ascii')
    encoded_key = base64.b64encode(public_key.encode('ascii')).decode('ascii')
    # Only the public key and setup code cross SSH. Passwords are never read by Python.
    code = 'import base64; exec(compile(base64.b64decode(' + repr(payload) + '), "<tunnel-setup>", "exec"))'
    remote = shlex.join(['sudo', '--', 'python3', '-c', code, encoded_key])
    print('Setting up tunnel access on ' + args.target + '. Enter SSH/sudo passwords only at the terminal prompts.', flush=True)
    subprocess.run(['ssh', '-tt', '-p', str(args.port), '-o', 'StrictHostKeyChecking=ask',
                    '-o', 'ConnectTimeout=10', args.target, remote], check=True)

    # Test key authentication and the actual remote Synapse endpoint before enabling it.
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        probe_port = sock.getsockname()[1]
    target = 'matrix-tunnel@' + args.target.split('@', 1)[1]
    ssh = subprocess.Popen(['ssh', '-N', '-T', '-p', str(args.port), '-i', str(key),
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
        '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ForkAfterAuthentication=no',
        '-L', f'127.0.0.1:{probe_port}:127.0.0.1:8008', target], stdin=subprocess.DEVNULL)
    verified = False
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and ssh.poll() is None:
            conn = http.client.HTTPConnection('127.0.0.1', probe_port, timeout=1)
            try:
                conn.request('GET', '/_matrix/client/versions')
                response = conn.getresponse()
                data = json.loads(response.read(65536))
                if response.status == 200 and isinstance(data, dict) and isinstance(data.get('versions'), list):
                    verified = True
                    break
            except (OSError, ValueError, http.client.HTTPException):
                pass
            finally:
                conn.close()
            time.sleep(0.25)
    finally:
        if ssh.poll() is None:
            ssh.terminate()
        try:
            ssh.wait(timeout=3)
        except subprocess.TimeoutExpired:
            ssh.kill()
            ssh.wait()
    if not verified:
        raise RuntimeError('Key/Synapse tunnel test failed. The local .env was not changed; review the SSH error above and server access rules.')
    env = root / '.env'
    settings = {'SYNAPSE_ADMIN_URL': 'http://127.0.0.1:18008', 'SYNAPSE_SSH_TARGET': target,
                'SYNAPSE_SSH_PORT': str(args.port), 'SYNAPSE_SSH_REMOTE_PORT': '8008',
                'SYNAPSE_SSH_IDENTITY': str(key)}
    lines = [line for line in env.read_text().splitlines()
             if not re.match(r'^\s*(?:export\s+)?(' + '|'.join(settings) + r')\s*=', line)]
    lines.extend(name + '=' + json.dumps(value) for name, value in settings.items())
    temp = env.with_name('.env.tunnel.tmp')
    fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write('\n'.join(lines) + '\n')
    os.replace(temp, env)
    print('Key authentication and Synapse tunnel verified; .env configured. Send !restart in Matrix to activate.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        # Do not print subprocess command arguments or password material.
        print('Setup failed: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
