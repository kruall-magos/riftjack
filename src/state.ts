import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EngineReport } from './bot-status.js';

export type Session = { codex?: string; codexInstructionsHash?: string; claude?: string; grok?: string; codexReport?: EngineReport; claudeReport?: EngineReport };
type Data = { version: 1; sessions: Record<string, Session>; seen: string[] };

export class State {
  private data: Data;
  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, sessions: {}, seen: [] };
    if (this.data.version !== 1 || !this.data.sessions || !Array.isArray(this.data.seen)) {
      throw new Error('Invalid state file. Restore it from a backup before restarting.');
    }
  }
  session(key: string): Session { return { ...this.data.sessions[key] }; }
  update(key: string, value: Session) {
    this.data.sessions[key] = { ...this.session(key), ...value };
    this.save();
  }
  reset(key: string) { delete this.data.sessions[key]; this.save(); }
  claim(id: string) {
    if (this.data.seen.includes(id)) return false;
    this.data.seen.push(id);
    this.data.seen = this.data.seen.slice(-10_000);
    this.save();
    return true;
  }
  private save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
