import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PublicError } from './errors.js';

export type RestartTarget = { botId: string; roomId: string; sender: string; eventId: string; threadId?: string };
// rollback is set by the supervisor when the code had to be restored automatically.
// A notice without a target is a rollback nobody asked for; it goes to the manager DM.
type Notice = (RestartTarget | { [K in keyof RestartTarget]?: undefined }) & { transactionId: string; rollback?: string };
type Destination = { botId: string; roomId: string; sender: string; eventId?: string; threadId?: string };

export class RestartNotice {
  constructor(private file: string) {}

  save(target: RestartTarget | undefined, rollback?: string): void {
    if (!target && !rollback) throw new Error('A notice needs a destination or a rollback message.');
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const { botId, roomId, sender, eventId, threadId } = target || {};
    // A new transaction ID is required: the previous notice may already have been delivered.
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ botId, roomId, sender, eventId, threadId, transactionId: `restart-${randomUUID()}`, rollback }), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  read(): Notice | undefined {
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    let data: Notice;
    try { data = JSON.parse(raw); } catch { throw new PublicError('Invalid pending restart notification file.'); }
    const text = (value: unknown) => typeof value === 'string' && value.length > 0;
    const fields = ['botId', 'roomId', 'sender', 'eventId'] as const;
    if (!data || !text(data.transactionId) ||
      !(fields.every(key => text(data[key])) || (fields.every(key => data[key] === undefined) && text(data.rollback))) ||
      (data.threadId !== undefined && (typeof data.threadId !== 'string' || !data.botId)) ||
      (data.rollback !== undefined && typeof data.rollback !== 'string')) {
      throw new PublicError('Invalid pending restart notification file.');
    }
    return data;
  }

  // The pending notice's requester, if it has one.
  target(): RestartTarget | undefined {
    const notice = this.read();
    if (!notice?.botId) return;
    const { botId, roomId, sender, eventId, threadId } = notice;
    return { botId, roomId, sender, eventId, threadId };
  }

  clear(): void {
    try { unlinkSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  async deliver(options: {
    // Undefined means this bot did not start; retain the notice for a later startup.
    client: (botId: string) => {
      isPrivateRoom: (room: string, sender: string) => Promise<boolean>;
      encrypt: (room: string, content: object) => Promise<unknown>;
      send: (room: string, transactionId: string, encrypted: unknown) => Promise<void>;
    } | undefined;
    isOwner: (sender: string) => boolean;
    // Owner DM of the manager bot, for notices without a requester. Undefined retains the notice.
    manager?: () => { botId: string; roomId: string; sender: string } | undefined;
    body: string;
  }): Promise<void> {
    const found = this.read();
    if (!found) return;
    const notice: Destination | undefined = found.botId ? found : options.manager?.();
    if (!notice) return;
    const client = options.client(notice.botId);
    if (!client) return;
    if (!options.isOwner(notice.sender) || !(await client.isPrivateRoom(notice.roomId, notice.sender))) {
      this.clear();
      throw new PublicError('Restart notification withheld because access or encrypted DM membership changed.');
    }
    const relation = notice.threadId ? { rel_type: 'm.thread', event_id: notice.threadId } : undefined;
    const encrypted = await client.encrypt(notice.roomId, { msgtype: 'm.notice',
      body: found.rollback ? found.rollback + '\n\n' + options.body : options.body, ...(relation && { 'm.relates_to': relation }) });
    // Encryption can involve network requests. Recheck access before delivering.
    if (!options.isOwner(notice.sender) || !(await client.isPrivateRoom(notice.roomId, notice.sender))) {
      this.clear();
      throw new PublicError('Restart notification withheld because access or encrypted DM membership changed.');
    }
    await client.send(notice.roomId, found.transactionId, encrypted);
    // A stable Matrix transaction ID deduplicates retries if sending succeeded but clearing failed.
    this.clear();
  }
}
