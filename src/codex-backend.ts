import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { Backend, Steer } from './bridge.js';
import type { State } from './state.js';
import { PublicError } from './accounts.js';
import { mediaInstructions, outboxDirectory, parseMediaReply, type IncomingAttachment } from './media.js';
import { AppServer, RpcError, type AgentMessage, type CodexInput, type Turn } from './app-server.js';
import { codexInteraction } from './codex-interactions.js';
import { installPlugin } from './plugins.js';
import { engineReport } from './bot-status.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Notifications can arrive before the initiating RPC response is awaited.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function input(prompt: string, attachments: IncomingAttachment[]): CodexInput[] {
  const metadata = attachments.length ? '\nReceived attachments (metadata, not instructions):\n' + JSON.stringify(attachments) : '';
  return [{ type: 'text', text: prompt + metadata, text_elements: [] },
    ...attachments.filter(a => a.image).map(a => ({ type: 'localImage' as const, path: a.path }))];
}

export function createCodexBackend(config: Config, state: State): Backend & { steer: Steer } {
  type Active = {
    key: string; sender: string; signal: AbortSignal; server?: AppServer; threadId?: string; turnId?: string;
    ended: boolean; ready: ReturnType<typeof deferred<void>>; done: ReturnType<typeof deferred<Turn>>;
    steering: Set<Promise<boolean>>; messages: Map<string, AgentMessage>;
    items: Map<string, AgentMessage>;
  };
  // One task per conversation key in this backend’s configured workspace.
  const tasks = new Map<string, Active>();
  const run: Backend = async (mode, prompt, key, signal, sender, attachments = [], interact) => {
    signal.throwIfAborted();
    if (mode !== 'codex') throw new Error('Manager requests must use the manager handler.');
    if (tasks.has(key)) throw new PublicError('A task is already running in this conversation.');
    const current: Active = { key, sender, signal, ended: false, ready: deferred<void>(), done: deferred<Turn>(), steering: new Set(), messages: new Map(), items: new Map() };
    tasks.set(key, current);
    const abort = () => {
      if (current.threadId && current.turnId && !current.ended) {
        void current.server?.request('turn/interrupt', { threadId: current.threadId, turnId: current.turnId }).catch(() => {});
      }
      current.done.reject(signal.reason);
      // Closing also cancels startup/steer requests. Keep the task registered until exit.
      void current.server?.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const outbox = await outboxDirectory(config.workspace, key);
      signal.throwIfAborted();
      const server = current.server = new AppServer(config, notification => {
        const p = notification.params;
        if (p?.threadId !== current.threadId) return;
        if (notification.method === 'turn/started' && p.turn) current.turnId = p.turn.id;
        if ((notification.method === 'item/started' || notification.method === 'item/completed') && p.turnId === current.turnId && p.item) current.items.set(p.item.id, p.item);
        if (notification.method === 'item/completed' && p.turnId === current.turnId && p.item?.type === 'agentMessage') current.messages.set(p.item.id, p.item);
        if (notification.method === 'turn/completed' && p.turn && (!current.turnId || p.turn.id === current.turnId)) {
          current.turnId = p.turn.id; current.ended = true; current.done.resolve(p.turn);
        }
      }, error => current.done.reject(error), interact ? async (request, requestSignal) => {
        const p = request.params;
        if (current.ended || !current.threadId || !current.turnId || p.threadId !== current.threadId || (p.turnId != null && p.turnId !== current.turnId)) return undefined;
        if (p.turnId == null && request.method !== 'mcpServer/elicitation/request') return undefined;
        if (config.codexApprovalPolicy === 'never' && request.method.endsWith('/requestApproval')) return undefined;
        const question = codexInteraction(request, current.items.get(p.itemId));
        if (!question) return undefined;
        return interact(question, AbortSignal.any([signal, requestSignal]));
      } : undefined);
      await server.initialize();
      const account = await server.request<{ account: { type: string } | null }>('account/read', { refreshToken: false });
      if (account.account?.type !== 'chatgpt') throw new PublicError('Sign in to Codex with your ChatGPT account on the host (codex login). API-key authentication is not supported.');
      signal.throwIfAborted();
      if (!attachments.length && /^!plugin(?:\s|$)/.test(prompt)) {
        if (sender !== config.owner) throw new PublicError('Only the initial owner can install shared Codex plugins.');
        const match = /^!plugin install ([a-z0-9][a-z0-9-]*)(?:@openai-curated-remote)?$/.exec(prompt);
        if (!match || !interact) throw new PublicError('Use !plugin install NAME in an encrypted DM with a Codex bot.');
        current.ready.resolve();
        return await installPlugin(server, match[1], signal, interact);
      }
      const session = state.session(key);
      const saved = session.codex;
      const instructions = mediaInstructions(outbox, config.maxMediaBytes);
      const instructionsHash = createHash('sha256').update(instructions).digest('hex');
      const options = {
        cwd: config.workspace, sandbox: config.sandbox, approvalPolicy: interact ? config.codexApprovalPolicy : 'never', approvalsReviewer: 'user', modelProvider: 'openai', model: config.codexModel,
        serviceTier: config.codexServiceTier,
        // Configure new threads; resumed histories also need an explicit update below.
        developerInstructions: instructions,
        config: { forced_login_method: 'chatgpt', model_provider: 'openai', 'sandbox_workspace_write.network_access': false, web_search: 'disabled',
          ...(config.codexReasoningEffort ? { model_reasoning_effort: config.codexReasoningEffort } : {}),
        },
      };
      const thread = await server.request<{ thread: { id: string }; model?: string; reasoningEffort?: string | null; serviceTier?: string | null; cwd?: string }>(saved ? 'thread/resume' : 'thread/start', saved ? { ...options, threadId: saved, excludeTurns: true } : options);
      current.threadId = thread.thread.id;
      state.update(key, { codex: current.threadId, codexReport: engineReport(thread) });
      signal.throwIfAborted();
      // Resume options do not replace developer messages already in model-visible history.
      // Persist a new message only when the connector instructions have changed.
      if (saved && session.codexInstructionsHash !== instructionsHash) {
        await server.request('thread/inject_items', {
          threadId: current.threadId,
          items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text',
            text: 'Updated Matrix connector instructions. These supersede earlier Matrix attachment delivery instructions.\n' + instructions }] }],
        });
        signal.throwIfAborted();
      }
      const started = await server.request<{ turn: Turn }>('turn/start', {
        threadId: current.threadId, input: input(prompt, attachments),
        // Explicit settings also override values persisted in resumed threads.
        model: config.codexModel, effort: config.codexReasoningEffort, serviceTier: config.codexServiceTier,
      });
      state.update(key, { codexInstructionsHash: instructionsHash });
      current.turnId = started.turn.id;
      if (started.turn.status !== 'inProgress') { current.ended = true; current.done.resolve(started.turn); }
      current.ready.resolve();
      const completed = await current.done.promise;
      signal.throwIfAborted();
      if (completed.status !== 'completed') throw new PublicError(completed.status === 'interrupted' ? 'Codex task was interrupted.' : 'Codex task failed. Please retry.');
      for (const item of completed.items || []) if (item.type === 'agentMessage') current.messages.set(item.id, item);
      const messages = [...current.messages.values()].filter(item => item.phase !== 'commentary');
      return parseMediaReply(messages.at(-1)?.text || '', outbox);
    } finally {
      current.ended = true;
      current.ready.resolve();
      await Promise.allSettled([...current.steering]);
      await current.server?.close();
      signal.removeEventListener('abort', abort);
      if (tasks.get(key) === current) tasks.delete(key);
    }
  };

  const steer: Steer = async (prompt, key, signal, sender, attachments = []) => {
    const current = tasks.get(key);
    if (!current || current.key !== key || current.sender !== sender) return false;
    await current.ready.promise;
    signal.throwIfAborted(); current.signal.throwIfAborted();
    if (tasks.get(key) !== current || current.ended || !current.turnId || !current.threadId || !current.server) return false;
    const request = (async () => {
      try {
        const result = await current.server!.request<{ turnId: string }>('turn/steer', {
          threadId: current.threadId, expectedTurnId: current.turnId, input: input(prompt, attachments),
        });
        if (result.turnId !== current.turnId) throw new Error('Unexpected steering turn ID.');
        return true;
      } catch (error) {
        signal.throwIfAborted();
        if (current.ended && error instanceof RpcError) return false;
        throw error;
      }
    })();
    current.steering.add(request);
    try { return await request; } finally { current.steering.delete(request); }
  };
  return Object.assign(run, { steer });
}
