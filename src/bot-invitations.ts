import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MatrixClient } from '@vector-im/matrix-bot-sdk';
import { PublicError } from './errors.js';

type Client = Pick<MatrixClient, 'createRoom' | 'getJoinedRooms' | 'getRoomState' | 'inviteUser'>;
type Record = { botId: string; userId: string; roomId?: string };
export type InvitationStatus = 'invited' | 'pending' | 'joined';

export class BotInvitations {
  private records = new Map<string, Record>();
  private active = new Map<string, Promise<InvitationStatus>>();
  constructor(private file: string) {
    if (!existsSync(file)) return;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.entries)) throw new Error('Invalid bot-dms.json');
    for (const entry of data.entries) {
      if (!entry || typeof entry.botId !== 'string' || typeof entry.userId !== 'string' ||
        !/^@[^\s:]+:[^\s]+$/.test(entry.botId) || !/^@[^\s:]+:[^\s]+$/.test(entry.userId) ||
        (entry.roomId !== undefined && (typeof entry.roomId !== 'string' || !entry.roomId.startsWith('!')))) throw new Error('Invalid bot-dms.json');
      const key = JSON.stringify([entry.botId, entry.userId]);
      if (this.records.has(key)) throw new Error('Duplicate bot DM record');
      this.records.set(key, entry);
    }
  }
  private save(key: string, record: Record) {
    const next = new Map(this.records); next.set(key, record);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, entries: [...next.values()] }, null, 2), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file); this.records = next;
  }
  ensure(botId: string, userId: string, client: Client, authorized: () => boolean, signal: AbortSignal): Promise<InvitationStatus> {
    const key = JSON.stringify([botId, userId]);
    const existing = this.active.get(key);
    if (existing) return existing;
    const work = this.invite(key, botId, userId, client, authorized, signal).finally(() => this.active.delete(key));
    this.active.set(key, work);
    return work;
  }
  private async invite(key: string, botId: string, userId: string, client: Client, authorized: () => boolean, signal: AbortSignal): Promise<InvitationStatus> {
    const check = () => {
      signal.throwIfAborted();
      if (!authorized()) throw new PublicError('Access revoked; no invitation was sent.');
    };
    check();
    const record = this.records.get(key);
    const inspect = async (roomId: string) => {
      const state = await client.getRoomState(roomId); check();
      const content = (type: string) => state.find(e => e.type === type && e.state_key === '')?.content;
      if (content('m.room.encryption')?.algorithm !== 'm.megolm.v1.aes-sha2' || content('m.room.join_rules')?.join_rule !== 'invite' ||
        content('m.room.history_visibility')?.history_visibility !== 'joined') return;
      const members = state.filter(e => e.type === 'm.room.member');
      if (members.some(e => ['join', 'invite', 'knock'].includes(String(e.content.membership)) && e.state_key !== botId && e.state_key !== userId)) return;
      if (members.find(e => e.state_key === botId)?.content.membership !== 'join') return;
      const membership = members.find(e => e.state_key === userId)?.content.membership;
      if (membership === 'join') return 'joined' as const;
      if (membership === 'invite') return 'pending' as const;
      // Re-invite only into a known private DM with history hidden until joining.
      if (roomId === record?.roomId && membership === 'leave' && content('m.room.history_visibility')?.history_visibility === 'joined') return 'reinvite' as const;
    };
    const use = async (roomId: string, status: 'joined' | 'pending' | 'reinvite'): Promise<InvitationStatus> => {
      this.save(key, { botId, userId, roomId }); check();
      if (status !== 'reinvite') return status;
      await client.inviteUser(userId, roomId); return 'invited';
    };
    if (record?.roomId) {
      const status = await inspect(record.roomId);
      if (status) return use(record.roomId, status);
    }
    // Includes chats created by users or the old startup path, and reconciles
    // createRoom requests whose response was lost before saving the room ID.
    const rooms = await client.getJoinedRooms(); check();
    for (const roomId of rooms) {
      if (roomId === record?.roomId) continue;
      const status = await inspect(roomId);
      if (status) return use(roomId, status);
    }
    if (record && !record.roomId) throw new PublicError('The previous room creation result is unknown. Access is retained; check invitations in Element X or open a DM with the bot manually.');
    check();
    this.save(key, { botId, userId }); // Persist uncertainty before a non-idempotent call.
    const roomId = await client.createRoom({
      is_direct: true, visibility: 'private', preset: 'private_chat', invite: [userId],
      initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
      ],
      power_level_content_override: { users: { [botId]: 100, [userId]: 50 }, invite: 100 },
    });
    if (typeof roomId !== 'string' || !roomId.startsWith('!')) throw new PublicError('The server did not return the new room ID; check invitations before retrying.');
    this.save(key, { botId, userId, roomId });
    return 'invited';
  }
}
