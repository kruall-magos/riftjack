#!/bin/sh
# Stops the running Riftjack supervisor of an instance and starts a fresh one in the background.
# Run on the host, outside any sandbox, from the instance directory (the one with .env and data/):
#   riftjack/scripts/restart-supervisor.sh     or     RIFTJACK_HOME=/path/to/instance …/restart-supervisor.sh
set -eu
code=$(cd "$(dirname "$0")/.." && pwd -P)
root=$(cd "${RIFTJACK_HOME:-.}" && pwd -P)
if [ "$root" = "$code" ] || [ ! -f "$root/.env" ]; then
  echo "No .env in $root. Run this from the instance directory or set RIFTJACK_HOME." >&2
  exit 1
fi
cd "$root"
node_bin=$(command -v node)
command -v python3 >/dev/null
command -v lsof >/dev/null
# Resolve tsx from the code: the instance directory has no node_modules of its own.
tsx=$(cd "$code" && "$node_bin" --input-type=module -e 'console.log((await import("node:url")).fileURLToPath(import.meta.resolve("tsx")))')
# Check that the replacement can load before stopping the running service.
"$node_bin" --import "$tsx" --input-type=module -e "await import('$code/src/supervisor.ts')"
# Read only DATA_DIR, without sourcing .env as shell code or printing credentials.
data_dir=$("$node_bin" --env-file-if-exists=.env -p 'require("node:path").resolve(process.env.DATA_DIR || "./data")')
mkdir -p "$data_dir"
log="$data_dir/connector-supervisor.log"
touch "$log"

candidates=$(python3 - <<'PY'
import os
import shlex
import subprocess
table = subprocess.check_output(['ps', '-axww', '-o', 'pid=,command='], text=True)
for line in table.splitlines():
    fields = line.strip().split(None, 1)
    if len(fields) != 2:
        continue
    try:
        args = shlex.split(fields[1])
    except ValueError:
        continue
    if args and os.path.basename(args[0]) == 'node' and any(
        arg == 'src/supervisor.ts' or arg.endswith('/src/supervisor.ts') for arg in args[1:]
    ):
        print(int(fields[0]))
PY
)
pids=""
for pid in $candidates; do
  # Other instances may run their own supervisor; never signal those processes.
  process_dir=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  if [ -z "$process_dir" ] && kill -0 "$pid" 2>/dev/null; then
    echo "Cannot identify supervisor $pid working directory; leaving running processes untouched." >&2
    exit 1
  fi
  if [ "$process_dir" = "$root" ]; then pids="$pids $pid"; fi
done
if [ -n "$pids" ]; then
  echo "Stopping supervisor: $pids"
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
fi
# Wait for every old supervisor/wrapper to disappear.
# A gap between connector children is not sufficient evidence that a supervisor stopped.
# A stale PID file is diagnostic only; the new connector acquires the OS lock.
i=0
while :; do
  running=0
  for pid in $pids; do if kill -0 "$pid" 2>/dev/null; then running=1; fi; done
  if [ "$running" -eq 0 ]; then break; fi
  if [ "$i" -ge 30 ]; then
    echo "The old supervisor has not stopped; not starting another instance." >&2
    exit 1
  fi
  sleep 1
  i=$((i + 1))
done

nohup "$node_bin" --import "$tsx" "$code/src/supervisor.ts" >> "$log" 2>&1 < /dev/null &
new_pid=$!
sleep 2
if ! kill -0 "$new_pid" 2>/dev/null; then
  echo "The new supervisor exited. Check $log" >&2
  exit 1
fi
echo "Started supervisor process (PID $new_pid). Bot readiness is reported in $log"
