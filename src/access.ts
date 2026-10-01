import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PublicError } from './accounts.js';
import type { Mode } from './bridge.js';

const validId = (id: string) => /^@[^\s:]+:[^\s]+$/.test(id);
export class Access {
  private users: Set<string>;
  private bots = new Map<string, Set<string>>();
  constructor(private file: string, readonly owner: string) {
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    const users = Array.isArray(saved) ? saved : saved?.version === 1 ? saved.users : undefined;
    const bots = Array.isArray(saved) ? {} : saved?.bots;
    const validList = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.every(id => typeof id === 'string' && validId(id));
    if (!validList(users) || !bots || typeof bots !== 'object' || Array.isArray(bots) ||
      Object.entries(bots).some(([id, members]) => !validId(id) || !validList(members))) throw new Error('Invalid allowed-users.json');
    this.users = new Set([...users, owner]);
    for (const [id, members] of Object.entries(bots)) this.bots.set(id, new Set(members as string[]));
  }
  has(id: string, botId?: string) { return this.users.has(id) || (botId !== undefined && !!this.bots.get(botId)?.has(id)); }
  list() { return [...this.users].sort(); }
  listBot(botId: string) { return [...(this.bots.get(botId) ?? [])].sort(); }
  private authorize(botKind: Mode, sender: string) {
    if (botKind !== 'manager' || sender !== this.owner) throw new PublicError('Only the initial owner can change account access, through the manager bot.');
  }
  // Account permission changes are exclusively manager commands from the recovery owner.
  change(botKind: Mode, sender: string, action: 'allow' | 'remove', id: string) {
    this.authorize(botKind, sender);
    if (!validId(id)) throw new PublicError('Use a full Matrix user ID such as @you:example.org.');
    if (action === 'remove' && id === this.owner) throw new PublicError('The initial owner cannot be removed in chat.');
    const users = new Set(this.users), bots = this.copyBots();
    if (action === 'allow') users.add(id);
    else { users.delete(id); for (const members of bots.values()) members.delete(id); }
    this.save(users, bots);
  }
  changeBot(botKind: Mode, sender: string, action: 'allow' | 'remove', botId: string, ids: string[]) {
    this.authorize(botKind, sender);
    if (!validId(botId) || !ids.length || ids.some(id => !validId(id))) throw new PublicError('Provide the full Matrix ID of each user.');
    if (action === 'remove' && ids.some(id => this.users.has(id))) throw new PublicError('This user has shared access to all bots. Revoke it with remove @user:server before granting access to individual bots. The owner always has access.');
    const bots = this.copyBots(), members = bots.get(botId) ?? new Set<string>();
    for (const id of ids) { if (action === 'allow') members.add(id); else members.delete(id); }
    bots.set(botId, members);
    this.save(new Set(this.users), bots);
  }
  private copyBots() { return new Map([...this.bots].map(([bot, ids]) => [bot, new Set(ids)])); }
  private save(users: Set<string>, bots: Map<string, Set<string>>) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, users: [...users].sort(),
      bots: Object.fromEntries([...bots].filter(([, ids]) => ids.size).map(([bot, ids]) => [bot, [...ids].sort()])) }, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    this.users = users; this.bots = bots;
  }
}

export type AccessRequest = { action: 'users' } | { action: 'allow' | 'remove'; userId: string };
export function parseAccessRequest(text: string): AccessRequest | null {
  const clean = text.trim();
  if (/^(?:list|show)(?:\s+(?:my|allowed|all))?\s+(?:users|accounts)$/i.test(clean)) return { action: 'users' };
  const match = /^(?:please\s+)?(allow|add|remove|revoke|disallow)(?:\s+(?:my|this))?(?:\s+(?:user|account))?\s+(@[^\s:]+:[^\s]+)$/i.exec(clean);
  if (!match) return null;
  return { action: /^(allow|add)$/i.test(match[1]) ? 'allow' : 'remove', userId: match[2] };
}
