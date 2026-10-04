import { PublicError } from './errors.js';
import type { ToolAction } from './tool-mcp.js';
import type { ConversationLinks } from './conversation-links.js';
import type { MatrixEvent } from './bridge.js';

export type MessageRequest = { action: 'list' } | { action: 'send'; room: string; text: string; id: string };
export type MessageAction = (request: MessageRequest, signal: AbortSignal) => Promise<string>;

export function linkedRoomMessages(links: ConversationLinks, bot: string,
  context: { event: MatrixEvent; key: string }, transport: {
    allowed(room: string, sender: string): Promise<boolean>;
    stopping(): boolean;
    send(room: string, content: { msgtype: 'm.text'; body: string; 'm.mentions': { user_ids: string[] } }): Promise<string>;
  }): MessageAction {
  return async (request, signal) => {
    const allowed = async (target: string) => {
      signal.throwIfAborted();
      const linked = () => !!links.room(bot, target) && links.key(bot, target, context.event) === context.key && !transport.stopping();
      if (!linked() || !(await transport.allowed(target, context.event.sender!)) || !linked()) {
        throw new PublicError('Room message withheld: destination access, membership or privacy changed.');
      }
      signal.throwIfAborted();
    };
    if (request.action === 'list') {
      const rooms: string[] = [];
      for (const target of links.sharedRooms(bot)) {
        try { await allowed(target); rooms.push(target); }
        catch { signal.throwIfAborted(); }
      }
      return JSON.stringify({ rooms });
    }
    await allowed(request.room);
    // Use the running client's encryption state. Do not inherit private thread
    // relations, mentions, approvals or a human origin from the source room.
    const eventId = await transport.send(request.room, {
      msgtype: 'm.text', body: request.text, 'm.mentions': { user_ids: [] },
    });
    return JSON.stringify({ status: 'sent', room: request.room, event_id: eventId });
  };
}

// One instance per backend turn. Cache failures too: an uncertain send must never
// be repeated automatically. This is deliberately not a persistent outbox.
export function roomMessageDelivery(send: MessageAction): ToolAction {
  const attempts = new Map<string, { content: string; result: Promise<string> }>();
  return async (input, signal) => {
    signal.throwIfAborted();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublicError('Expected a room message request.');
    const r = input as Record<string, unknown>;
    if (r.action === 'list' && Object.keys(r).length === 1) return send({ action: 'list' }, signal);
    if (r.action !== 'send' || Object.keys(r).some(k => !['action', 'room', 'text', 'id'].includes(k)) ||
        typeof r.room !== 'string' || !/^![^\s:]+:[^\s]+$/.test(r.room) ||
        typeof r.text !== 'string' || !r.text.trim() || Buffer.byteLength(r.text, 'utf8') > 8000 ||
        typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(r.id)) {
      throw new PublicError('Use action=list, or action=send with room, text (up to 8000 UTF-8 bytes), and a unique id (letters, digits, underscore or hyphen; up to 80 characters).');
    }
    const request: MessageRequest = { action: 'send', room: r.room, text: r.text, id: r.id };
    const content = JSON.stringify([r.room, r.text]);
    const previous = attempts.get(r.id);
    if (previous) {
      if (previous.content !== content) throw new PublicError('This message id was already used with different content.');
      return previous.result;
    }
    if (attempts.size >= 32) throw new PublicError('Room message limit reached for this turn.');
    const result = Promise.resolve().then(() => { signal.throwIfAborted(); return send(request, signal); });
    attempts.set(r.id, { content, result });
    return result;
  };
}
