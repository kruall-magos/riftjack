#!/bin/sh
# Start on macOS from the instance directory, or set RIFTJACK_HOME.
set -eu
umask 077
PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}:/opt/homebrew/bin:/usr/local/bin"
export PATH
code=$(cd "$(dirname "$0")/.." && pwd -P)
root=$(cd "${RIFTJACK_HOME:-.}" && pwd -P)
if [ "$root" = "$code" ] || [ ! -f "$root/.env" ]; then
    echo "Run from the instance directory or set RIFTJACK_HOME." >&2
    exit 1
fi
cd "$root"

node_bin=$(command -v node) || { echo 'Install Node.js 24+ first.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 1; }
command -v lsof >/dev/null || { echo 'lsof is required.' >&2; exit 1; }
"$node_bin" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24+ is required."); process.exit(1); }'
if [ ! -d "$code/node_modules/tsx" ]; then
    echo "Install dependencies first: npm --prefix \"$code\" ci" >&2
    exit 1
fi
tsx=$(cd "$code" && "$node_bin" --input-type=module -e 'console.log((await import("node:url")).fileURLToPath(import.meta.resolve("tsx")))')
# Parse dotenv with Node; never execute .env as shell code. Keep it out of the
# supervisor environment so its children can reload settings after !restart.
data_dir=$("$node_bin" --env-file-if-exists=.env -p 'require("node:path").resolve(process.env.DATA_DIR || "./data")')
"$node_bin" --env-file-if-exists=.env --import "$tsx" "$code/src/main.ts" --check-config

python3 - "$root" "$node_bin" "$data_dir" "$code" "$tsx" <<'PY'
import fcntl
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

root, node, directory, code, tsx = sys.argv[1:]
data = Path(directory)
data.mkdir(mode=0o700, parents=True, exist_ok=True)
log = data / 'connector-supervisor.log'

def fail(message):
    sys.exit(message)

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

# The OS releases this lock even after a crash/reboot. Leave the file in place
# so simultaneous invocations always lock the same inode.
with (data / 'connector-start.lock').open('a') as start_lock:
    try:
        fcntl.flock(start_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fail('Another startup script is running. Try again in a few seconds.')

    # A supervisor may be between child processes, with no connector.pid yet.
    # Check supervisors launched manually or by the restart script as well.
    table = subprocess.check_output(['ps', '-axww', '-o', 'pid=,command='], text=True)
    for line in table.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        try:
            args = shlex.split(fields[1])
        except ValueError:
            continue
        if not args or os.path.basename(args[0]) != os.path.basename(node):
            continue
        if not any(arg == 'src/supervisor.ts' or arg.endswith('/src/supervisor.ts') for arg in args[1:]):
            continue
        pid = int(fields[0])
        result = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        directories = [line[1:] for line in result.stdout.splitlines() if line.startswith('n')]
        if not directories and alive(pid):
            fail(f'Cannot identify supervisor {pid}; leaving running processes untouched.')
        if any(os.path.realpath(path) == root for path in directories):
            print(f'Connector supervisor is already running (PID {pid}).')
            sys.exit(0)

    # PID files are diagnostic only. The connector acquires its own OS lock,
    # which also protects launches that bypass this script.

    with log.open('ab', buffering=0) as output:
        child = subprocess.Popen([node, '--import', tsx, str(Path(code) / 'src/supervisor.ts')],
                                 cwd=root, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                 start_new_session=True, close_fds=True)
    time.sleep(2)
    if child.poll() is not None:
        fail(f'Connector supervisor exited. Check {log}')
    print(f'Started connector supervisor (PID {child.pid}). You can close this terminal.')
    print(f'Bot readiness and errors: {log}')
PY
