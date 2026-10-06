import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class InstanceBusyError extends Error {
  constructor() { super('Another connector is using this data directory. Stop that instance before starting another.'); }
}

// SQLite's exclusive transaction holds OS file locks for this process. No data
// is committed: the database is only a lock, independent of the diagnostic PID.
// Never unlink this file, even on clean shutdown: contenders must use one inode.
export function lockInstance(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'connector.lock.sqlite');
  const pidFile = join(dir, 'connector.pid');
  const pid = String(process.pid);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    // Only the lock owner can replace a stale PID, including a reused live PID.
    writeFileSync(pidFile, pid, { mode: 0o600 });
  } catch (error) {
    db?.close();
    const code = (error as { errcode?: number }).errcode;
    if (code === 5 || code === 6) throw new InstanceBusyError(); // SQLITE_BUSY / SQLITE_LOCKED
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try {
      if (readFileSync(pidFile, 'utf8') === pid) unlinkSync(pidFile);
    } catch { /* Diagnostic cleanup must not prevent releasing the OS lock. */ }
    db!.close();
  };
  process.once('exit', release);
  return release;
}
