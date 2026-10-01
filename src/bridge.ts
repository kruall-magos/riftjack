import type { State } from './state.js';
import { PublicError } from './accounts.js';
import { errorMessage } from './errors.js';
import type { RestartTarget } from './restart-notice.js';
import type { RestartScope } from './restart.js';
import { MANAGER_HELP } from './manager-help.js';
import { botHelp } from './bot-help.js';
import { isMedia, type MediaContent, type IncomingAttachment, type OutgoingAttachment, type BackendReply } from './media.js';
import { Interactions, type Interact, type ReactionControls } from './interactions.js';

export type MatrixEvent = {
  type?: string; event_id?: string; sender?: string; origin_server_ts?: number;
  content?: MediaContent & { 'm.relates_to'?: { rel_type?: string; event_id?: string; key?: string; 'm.in_reply_to'?: { event_id: string } } };
};
export type Mode = 'codex' | 'claude' | 'grok' | 'manager';
export type Backend = (mode: Mode, prompt: string, key: string, signal: AbortSignal, sender: string, attachments?: IncomingAttachment[], interact?: Interact) => Promise<string | BackendReply>;
export type Steer = (prompt: string, key: string, signal: AbortSignal, sender: string, attachments?: IncomingAttachment[]) => Promise<boolean>;
type Options = {
  botId: string; isAuthorized: (user: string) => boolean; kind: Mode; since: number; timeoutMs: number;
  isPrivateRoom: (room: string, sender: string) => Promise<boolean>;
  state: State; run: Backend;
  steer?: Steer;
  queuedUpdateMessage?: string;
  owner?: string;
  isStopping?: () => boolean;
  restart?: (reply: (text: string) => Promise<void>, target: RestartTarget, scope: RestartScope) => Promise<void>;
  reply: (room: string, event: MatrixEvent, text: string, markdown?: boolean) => Promise<void>;
  confirmation?: (room: string, event: MatrixEvent, text: string, controls: ReactionControls, markdown: string) => Promise<void>;
  receive?: (event: MatrixEvent, key: string, signal: AbortSignal) => Promise<IncomingAttachment>;
  acceptManagerAvatar?: (prompt: string, sender: string) => boolean;
  sendAttachments?: (room: string, event: MatrixEvent, files: OutgoingAttachment[], signal: AbortSignal) => Promise<void>;
  status?: (key: string) => string;
  // Account usage and limits of the engine.
  usage?: (signal: AbortSignal) => Promise<string>;
  report: (error: unknown) => void;
};
function help(kind: Mode): string {
  return kind === 'manager' ? MANAGER_HELP : botHelp(kind);
}

type Followup = { prompt: string; event: MatrixEvent; attachments: IncomingAttachment[] };
type Active = {
  room: string; event: MatrixEvent;
  key: string; sender: string; controller: AbortController; running: boolean; failed: boolean;
  ready: Promise<void>; markReady: () => void; steering: Promise<void>; buffered: number; followups: Followup[];
  interactions: Interactions;
};

export function sessionKey(room: string, event: MatrixEvent) {
  const relation = event.content?.['m.relates_to'];
  return JSON.stringify([room, event.sender, relation?.rel_type === 'm.thread' ? relation.event_id : null]);
}

export class Bridge {
  private active?: Active;
  private stopped = false;
  constructor(private options: Options) {}
  get busy(): boolean { return !!this.active; }
  stop() { this.stopped = true; this.active?.controller.abort(); }
  revoke(sender: string) { if (this.active?.sender === sender) this.active.controller.abort(); }
  async handle(room: string, event: MatrixEvent): Promise<void> {
    const o = this.options;
    if (!event.sender || !o.isAuthorized(event.sender) || event.sender === o.botId) return;
    if (event.type === 'm.reaction') { await this.handleReaction(room, event); return; }
    const media = isMedia(event.content?.msgtype);
    if (event.type !== 'm.room.message' || (event.content?.msgtype !== 'm.text' && !media) || !event.event_id) return;
    if (!Number.isFinite(event.origin_server_ts) || event.origin_server_ts! < o.since) return;
    if (event.content?.['m.relates_to']?.rel_type === 'm.replace') return;
    const body = !media && event.content?.['m.relates_to']?.['m.in_reply_to']
      ? event.content.body?.replace(/^>[^\n]*(?:\r?\n>[^\n]*)*\r?\n\r?\n/, '') : event.content?.body;
    const prompt = body?.trim() || (media ? 'An attachment was sent. Describe what you can inspect, or ask what to do with it.' : '');
    if (!prompt || !(await o.isPrivateRoom(room, event.sender)) || !o.isAuthorized(event.sender) || !o.state.claim(event.event_id)) return;
    // Attachments never execute conversation controls. Manager avatar captions are allowed explicitly below.
    const restartSupervisor = !media && /^!restart\s+supervisor$/.test(prompt);
    const verb = restartSupervisor ? 'restart' : (!media && /^!(help|reset|cancel|restart|usage|status)$/.exec(prompt)?.[1]) || o.kind;
    const key = sessionKey(room, event);
    const reply = (text: string) => o.reply(room, event, text);
    if (this.stopped || o.isStopping?.()) { await reply('The connector is restarting or stopping. Please retry in a few seconds.'); return; }
    if (!media && /^!(approve|deny|answer)(?:\s|$)/.test(prompt)) {
      const current = this.active;
      if (!current || current.key !== key || current.sender !== event.sender) { await reply('No pending confirmation in this conversation.'); return; }
      await this.authorize(room, current);
      await reply(current.interactions.answer(prompt));
      return;
    }
    if (!media && /^!plugin(?:\s|$)/.test(prompt)) {
      if (o.kind !== 'codex') { await reply('Plugin installation is available through Codex bots only.'); return; }
      if (event.sender !== o.owner) { await reply('Only the initial owner can install plugins shared by the Codex account.'); return; }
      if (!/^!plugin install [a-z0-9][a-z0-9-]*(?:@openai-curated-remote)?$/.test(prompt)) { await reply('Use !plugin install NAME, for example !plugin install github.'); return; }
      if (this.active) { await reply('Wait for the current task to finish before installing a plugin.'); return; }
    } else if (!media && prompt.startsWith('!') && verb === o.kind) {
      await reply('Unknown command or invalid syntax. Send !help to see the available commands.');
      return;
    }
    if (verb === 'restart') {
      if (event.sender !== o.owner) { await reply('Only the initial owner can restart the connector.'); return; }
      try {
        if (!o.restart) throw new PublicError('Restart is not configured for this connector.');
        const relation = event.content?.['m.relates_to'];
        await o.restart(reply, { botId: o.botId, roomId: room, sender: event.sender, eventId: event.event_id,
          threadId: relation?.rel_type === 'm.thread' ? relation.event_id : undefined }, restartSupervisor ? 'supervisor' : 'connector');
      } catch (error) {
        o.report(error);
        if (error instanceof PublicError) await reply(error.message);
        // A failed acknowledgement must not cause a restart or a second unsafe delivery attempt.
      }
      return;
    }
    if (media && o.kind === 'manager') {
      try {
        if (event.content?.msgtype !== 'm.image' || !o.acceptManagerAvatar?.(prompt, event.sender)) {
          await reply('The manager only accepts avatar images: use set avatar <bot name> as the caption. Only the connector owner or bot creator can change its profile. Send other files to a Codex or Claude bot.'); return;
        }
      } catch (error) {
        if (!(error instanceof PublicError)) throw error;
        await reply(error.message); return;
      }
    }
    if (verb === 'help') { await o.reply(room, event, help(o.kind), true); return; }
    if (verb === 'status') {
      if (!o.status) { await reply('!status is not available for this bot.'); return; }
      const current = this.active;
      const task = !current ? 'Idle' : current.key !== key ? 'Busy in another conversation'
        : current.controller.signal.aborted ? 'Cancelling' : current.running ? 'Running' : 'Preparing or delivering';
      const queued = current?.key === key ? `\nQueued follow-ups: ${current.followups.length}. Pending updates: ${current.buffered}.` : '';
      await o.reply(room, event, o.status(key) + `\n\n**Task:** ${task}${queued}`, true);
      return;
    }
    // Reads the account's limits without a model request, so it is allowed while a task runs.
    if (verb === 'usage') {
      if (!o.usage) { await reply('!usage is not available for this bot.'); return; }
      if (event.sender !== o.owner) { await reply('Only the initial owner can view the account usage.'); return; }
      try { await o.reply(room, event, await o.usage(AbortSignal.timeout(30_000)), true); }
      catch (error) { o.report(error); await reply(errorMessage(error, 'Could not read account usage')); }
      return;
    }
    if (verb === 'cancel') {
      if (this.active?.key === key) {
        this.active.controller.abort();
        await reply('Cancellation requested. Changes already made are retained.');
      } else await reply('No active task in your conversation.');
      return;
    }
    if (!prompt || prompt.length > 16_000) { await o.reply(room, event, 'Supply a prompt of 1–16,000 characters.\n' + help(o.kind), true); return; }
    if (this.active) {
      if ((verb === 'codex' || verb === 'claude') && this.active.key === key && o.steer) {
        await this.steer(this.active, room, event, prompt);
      } else await reply('A task is running in this bot. Only messages in its active conversation can steer it; wait before resetting or starting another conversation.');
      return;
    }
    if (verb === 'reset') { o.state.reset(key); await reply('Your conversation state has been reset.'); return; }
    const controller = new AbortController();
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const current: Active = { room, event, key, sender: event.sender, controller, running: false, failed: false,
      ready, markReady, steering: Promise.resolve(), buffered: 0, followups: [], interactions: new Interactions() };
    this.active = current;
    let timedOut = false;
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, o.timeoutMs);
    try {
      if (verb === 'codex' || verb === 'claude') await reply('Working on it…');
      let next: Followup | undefined = { prompt, event, attachments: await this.receive(room, event, current) };
      while (next) {
        controller.signal.throwIfAborted();
        await this.authorize(room, current);
        current.running = true;
        const requestEvent = next.event;
        const interact: Interact = (request, requestSignal) => current.interactions.ask(request,
          AbortSignal.any([controller.signal, requestSignal]), async (text, controls, markdown) => {
            await this.authorize(room, current);
            if (o.confirmation) await o.confirmation(room, requestEvent, text, controls, markdown);
            else await o.reply(room, requestEvent, text);
          });
        const task = o.run(verb as Mode, next.prompt, key, controller.signal, event.sender, next.attachments, interact);
        current.markReady();
        let result: string | BackendReply;
        try { result = await task; } finally { current.running = false; current.interactions.close(); }
        while (current.buffered) await current.steering;
        controller.signal.throwIfAborted();
        const respond = (text: string) => o.reply(room, next!.event, text, !next!.prompt.startsWith('!'));
        if (typeof result === 'string') {
          await respond(result || 'The task completed without a text response.');
        } else {
          if (result.text) await respond(result.text);
          if (result.attachments.length) {
            if (!o.sendAttachments) throw new PublicError('Attachment sending is not configured.');
            await o.sendAttachments(room, next.event, result.attachments, controller.signal);
          } else if (!result.text) await respond('The task completed without a response.');
        }
        while (current.buffered) await current.steering;
        next = current.followups.shift();
      }
    } catch (error) {
      current.failed = true;
      current.markReady();
      while (current.buffered) await current.steering;
      o.report(error);
      await reply(controller.signal.aborted
        ? `Task ${timedOut ? 'timed out' : 'cancelled'}. Pending follow-ups were discarded. Changes already made are retained.`
        : errorMessage(error) + (current.followups.length ? ' Pending follow-ups were not run; please resend them.' : ''));
    } finally {
      current.interactions.close();
      clearTimeout(timeout);
      this.active = undefined;
    }
  }

  private async handleReaction(room: string, event: MatrixEvent): Promise<void> {
    const o = this.options, current = this.active;
    const relation = event.content?.['m.relates_to'];
    if (this.stopped || o.isStopping?.() || !current || current.failed || current.room !== room || current.sender !== event.sender ||
      !event.event_id || !Number.isFinite(event.origin_server_ts) || event.origin_server_ts! < o.since ||
      relation?.rel_type !== 'm.annotation' || !relation.event_id || !['✅', '❌', '✅\uFE0F', '❌\uFE0F'].includes(relation.key || '') ||
      !current.interactions.hasReactionTarget(relation.event_id)) return;
    // Reactions carry the confirmation event ID, not a thread relation. The
    // exact bound message supplies the room/thread scope; never guess a request.
    await this.authorize(room, current);
    if (this.active !== current || !o.state.claim(event.event_id)) return;
    const answer = current.interactions.react(relation.event_id, relation.key!);
    if (answer) await o.reply(room, current.event, answer);
  }

  private async authorize(room: string, active: Active): Promise<void> {
    if (!this.options.isAuthorized(active.sender) || !(await this.options.isPrivateRoom(room, active.sender))) throw new PublicError('Task stopped because access or room membership changed.');
    active.controller.signal.throwIfAborted();
    if (!this.options.isAuthorized(active.sender)) throw new PublicError('Account access was revoked.');
  }

  private async receive(room: string, event: MatrixEvent, active: Active): Promise<IncomingAttachment[]> {
    await this.authorize(room, active);
    if (!isMedia(event.content?.msgtype)) return [];
    if (!this.options.receive) throw new PublicError('Attachment reception is not configured.');
    const file = await this.options.receive(event, active.key, active.controller.signal);
    await this.authorize(room, active);
    return [file];
  }

  private async steer(active: Active, room: string, event: MatrixEvent, prompt: string): Promise<void> {
    const o = this.options;
    if (active.buffered + active.followups.length >= 10) { await o.reply(room, event, 'Too many pending messages. Wait for the agent to catch up.'); return; }
    active.buffered++;
    const operation = active.steering.then(async () => {
      const attachments = await this.receive(room, event, active);
      await active.ready;
      active.controller.signal.throwIfAborted();
      if (active.failed) throw new PublicError('The task failed before your update could be applied. Please resend your message.');
      await this.authorize(room, active);
      const accepted = active.running && await o.steer!(prompt, active.key, active.controller.signal, active.sender, attachments);
      if (!accepted) active.followups.push({ prompt, event, attachments });
      try {
        await o.reply(room, event, accepted ? 'Added your message to the current task.' : o.queuedUpdateMessage || 'The current task is finishing. Your message will be processed next.');
      } catch (error) { o.report(error); }
    }).catch(async error => {
      o.report(error);
      const message = active.controller.signal.aborted ? 'Your update was not applied because the task was stopped.'
        : errorMessage(error, 'Could not confirm delivery of your update to the agent') + ' Please check the task result before resending.';
      try { await o.reply(room, event, message); } catch (replyError) { o.report(replyError); }
    }).finally(() => { active.buffered--; });
    active.steering = operation;
    await operation;
  }
}

export function messageParts(text: string): string[] {
  const parts: string[] = [];
  // 3000 Unicode code points stay below Matrix's event size limit, including escaping.
  const points = Array.from(text.slice(0, 100_000));
  for (let i = 0; i < points.length; i += 3000) parts.push(points.slice(i, i + 3000).join(''));
  if (text.length > 100_000) parts.push('[Response truncated at 100,000 characters.]');
  return parts;
}
