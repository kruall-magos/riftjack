import { NOTICE, type MatrixEvent } from './bridge.js';

export type ReactionReader = (room: string, eventId: string) => Promise<MatrixEvent | undefined>;

export function feedbackMeaning(key: unknown): string | undefined {
  if (typeof key !== 'string' || key.length > 16) return;
  const emoji = key.replace(/\uFE0F/g, '');
  if (/^👍[\u{1F3FB}-\u{1F3FF}]?$/u.test(emoji)) return 'agreement; on a proposed next step, yes, go ahead';
  if (/^👎[\u{1F3FB}-\u{1F3FF}]?$/u.test(emoji)) return 'disapproval or negative feedback';
  if (emoji === '❤' || emoji === '♥') return 'strong appreciation or support; on a proposed next step, may mean yes, go ahead';
}

// Resolve the original message in this room, rather than trusting a reaction's
// text or claimed thread. The generated prompt is feedback, never a chat command.
export async function reactionFeedback(room: string, event: MatrixEvent, options: {
  botId: string;
  authorized: (sender: string) => boolean;
  privateRoom: (room: string, sender: string) => Promise<boolean>;
  read: ReactionReader;
}): Promise<MatrixEvent | undefined> {
  const relation = event.content?.['m.relates_to'];
  const meaning = feedbackMeaning(relation?.key);
  if (event.type !== 'm.reaction' || !event.event_id || !event.sender || event.sender === options.botId ||
    !Number.isFinite(event.origin_server_ts) || relation?.rel_type !== 'm.annotation' ||
    typeof relation.event_id !== 'string' || !relation.event_id || relation.event_id.length > 1024 || !meaning) return;
  const allowed = async () => options.authorized(event.sender!) && await options.privateRoom(room, event.sender!) && options.authorized(event.sender!);
  if (!(await allowed())) return;
  const target = await options.read(room, relation.event_id);
  if (!target || target.event_id !== relation.event_id || target.sender !== options.botId || target.type !== 'm.room.message' ||
    // Notices include confirmations and status messages, not conversational feedback.
    target.content?.msgtype !== 'm.text' || typeof target.content.body !== 'string' || !target.content.body.trim() ||
    target.content['m.relates_to']?.rel_type === 'm.replace' || (target.room_id && target.room_id !== room)) return;
  const thread = target.content['m.relates_to'];
  if (thread?.rel_type === 'm.thread' && (typeof thread.event_id !== 'string' || !thread.event_id)) return;
  if (!(await allowed())) return;
  return { type: 'm.room.message', event_id: event.event_id, sender: event.sender, origin_server_ts: event.origin_server_ts,
    content: { msgtype: 'm.text', [NOTICE]: 'reaction', body: 'The conversation partner reacted to an earlier message from this bot. Interpret the reaction in the context of that message and the ongoing conversation. '
      + 'A thumbs-up usually expresses agreement or approval; a heart expresses strong appreciation or support. On a concrete proposed next step within the agreed work, either can mean "yes, go ahead"; continue the agreed work instead of only acknowledging the reaction. '
      + 'A reaction to a completed result or a personal remark may simply express appreciation; do not invent a new task from it. '
      + 'Reactions do not answer pending confirmation requests or replace required approvals, including publication approval. The quoted message below is context for the reaction.\n'
      + JSON.stringify({ reaction: relation.key, meaning, messageId: target.event_id,
        message: target.content.body.slice(0, 2000), truncated: target.content.body.length > 2000 }),
      ...(thread?.rel_type === 'm.thread' && { 'm.relates_to': { rel_type: 'm.thread', event_id: thread.event_id } }),
    } };
}
