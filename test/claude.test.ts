import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend, routeBackends } from '../src/backends.js';
import { checkClaude, claudeApprovals, claudeArguments, claudeUsage } from '../src/claude-backend.js';
import type { Interact, Interaction } from '../src/interactions.js';
import { loadConfig } from '../src/config.js';
import { State } from '../src/state.js';
import { Bridge, sessionKey, type Backend, type MatrixEvent } from '../src/bridge.js';
import { provision } from '../src/accounts.js';
import type { BackendReply } from '../src/media.js';
import { configForWorkspace } from '../src/workspace.js';

function setup(t: { after(fn: () => void): void }, options: { auth?: string; malformed?: boolean; legacy?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'matrix-claude-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, 'claude.cjs');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const record = value => fs.appendFileSync(__filename + '.calls', JSON.stringify(value) + '\\n');
record({ args, cwd: process.cwd(), secrets: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'SYNAPSE_ADMIN_TOKEN', 'MATRIX_OWNER_ID', 'ANTHROPIC_BASE_URL', 'CLAUDECODE'].filter(key => process.env[key]) });
if (args.includes('--help')) {
  console.log(${JSON.stringify(options.legacy ? '--help' : '--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume')}); process.exit(0);
}
if (args[0] === 'auth') {
  console.log(${JSON.stringify(options.malformed ? 'not json' : JSON.stringify({ loggedIn: options.auth !== 'none', authMethod: options.auth || 'claude.ai', apiProvider: 'firstParty' }))}); process.exit(0);
}
if (args[0] === '-p' && args[1] === '/usage') {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'usage-session' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Current session: 13% used · resets 7:50pm\\n', total_cost_usd: 0 }));
  process.exit(0);
}
const lock = path.join(__dirname, 'active.lock');
fs.closeSync(fs.openSync(lock, 'wx'));
process.on('exit', () => fs.unlinkSync(lock));
const output = value => console.log(JSON.stringify(value));
let started = false, onResponse;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (started) { record({ response: message }); onResponse?.(message); return; }
  started = true; record({ input: message });
  const prompt = message.message.content[0].text;
  output({ type: 'system', subtype: 'init', session_id: 'claude-session-1', ...(prompt.includes('[missing-status]') ? {} : { model: 'resolved-claude', cwd: process.cwd(), permissionMode: 'acceptEdits', fast_mode_state: 'off' }) });
  const finish = result => output({ type: 'result', subtype: 'success', is_error: false, result, session_id: 'claude-session-1' });
  if (prompt.includes('[permission]')) {
    output({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x', description: 'Create x', timeout: 5 }, decision_reason: 'Outside the sandbox' } });
    onResponse = response => finish('Permission ' + response.response.response.behavior);
    return;
  }
  if (prompt.includes('[withdrawn]')) {
    output({ type: 'control_request', request_id: 'perm-2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/tmp/x', content: 'a' } } });
    setTimeout(() => { output({ type: 'control_cancel_request', request_id: 'perm-2' }); setTimeout(() => finish('withdrawn'), 50); }, 50);
    return;
  }
  if (prompt.includes('[unknown-control]')) {
    output({ type: 'control_request', request_id: 'x-1', request: { subtype: 'hook_callback' } });
    onResponse = response => finish('Unknown ' + response.response.subtype);
    return;
  }
  if (prompt.includes('[bad-json]')) { console.log('invalid JSON'); return; }
  if (prompt.includes('[wait]')) { record({ waiting: true }); setInterval(() => {}, 1000); return; }
  if (prompt.includes('[approval]')) { output({ type: 'control_request', request: { subtype: 'can_use_tool' } }); setInterval(() => {}, 1000); return; }
  if (prompt.includes('[fail]')) { output({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'claude-session-1' }); return; }
  if (prompt.includes('[no-result]')) return;
  if (prompt.includes('[progress]')) {
    output({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Not user-facing' }, { type: 'text', text: 'Checking the files.' }, { type: 'tool_use', name: 'Read', input: {} }] } });
    output({ type: 'assistant', message: { content: [{ type: 'text', text: 'Running the checks.' }] } });
    output({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
  }
  let result = 'Claude answer';
  if (prompt.includes('[attachment]')) {
    const instructions = args[args.indexOf('--append-system-prompt') + 1];
    const root = JSON.parse(instructions.split("conversation's outbox: ")[1].split('. It is emptied')[0]);
    fs.writeFileSync(path.join(root, 'answer.txt'), 'Claude file');
    result = 'Here is the file.\\n' + String.fromCharCode(96).repeat(3) + 'matrix-attachments\\n' + JSON.stringify({ files: [{ path: 'answer.txt' }] }) + '\\n' + String.fromCharCode(96).repeat(3);
  }
  output({ type: 'assistant', message: { content: [{ type: 'text', text: result }] }, session_id: 'claude-session-1' });
  output({ type: 'result', subtype: 'success', is_error: false, result, session_id: 'claude-session-1' });
});
process.on('SIGTERM', () => { record({ stopped: true }); process.exit(0); });
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: dir, CLAUDE_PATH: executable });
  const state = new State(join(dir, 'state.json'));
  const backend = createBackend(config, state);
  const calls = () => existsSync(executable + '.calls') ? readFileSync(executable + '.calls', 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { dir, config, state, backend, calls };
}
const signal = () => new AbortController().signal;
test('Claude tasks work when the Codex executable is unavailable', async t => {
  const f = setup(t);
  const backend = createBackend({ ...f.config, codexPath: join(f.dir, 'codex-not-installed') }, f.state);
  assert.equal(await backend('claude', 'Hello', 'claude-only', signal(), '@owner:test'), 'Claude answer');
  assert.equal(f.state.session('claude-only').claude, 'claude-session-1');
  assert.equal(f.state.session('claude-only').codex, undefined);
});

test('per-bot Claude workspace is used for auth, execution and outgoing files', async t => {
  const f = setup(t);
  const project = join(f.dir, 'Other Project'); mkdirSync(project);
  const backend = createBackend(configForWorkspace(f.config, project), f.state);
  const result = await backend('claude', '[attachment]', 'custom-room', signal(), '@owner:test') as BackendReply;
  assert.ok(f.calls().filter(call => call.args).every(call => call.cwd === realpathSync(project)));
  assert.ok(result.attachments[0].path.startsWith(join(realpathSync(project), '.matrix-media')));
  assert.equal(existsSync(join(f.config.workspace, '.matrix-media')), false);
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fake Claude did not start'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('Claude readiness checks options and login without a model request', async t => {
  const f = setup(t);
  await checkClaude(f.config);
  assert.deepEqual(f.calls().map(call => call.args), [['--help'], ['auth', 'status', '--json']]);
});

test('missing Claude executable fails with setup instructions without affecting Codex configuration', async t => {
  const f = setup(t);
  await assert.rejects(checkClaude({ ...f.config, claudePath: join(f.dir, 'missing') }), /Install it on the host/);
  assert.equal(f.config.sandbox, 'workspace-write');
});

for (const options of [{ auth: 'api_key' }, { auth: 'none' }, { malformed: true }, { legacy: true }]) {
  test('Claude readiness fails closed for ' + JSON.stringify(options), async t => {
    const f = setup(t, options);
    await assert.rejects(f.backend('claude', 'hello', 'conversation', signal(), '@owner:test'));
    assert.ok(!f.calls().some(call => call.args?.includes('--print')));
  });
}

test('connector instructions go to the system prompt, not into the user message', async t => {
  const f = setup(t);
  await f.backend('claude', 'hello', 'conversation', signal(), '@owner:test');
  const run = f.calls().find(call => call.args?.includes('--print'));
  assert.match(run.args[run.args.indexOf('--append-system-prompt') + 1], /conversation's outbox: ".*outbox"/);
  assert.equal(f.calls().find(call => call.input).input.message.content[0].text, 'hello');
});

test('Claude uses its own login/session and never inherits connector credentials or API keys', async t => {
  const f = setup(t);
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'SYNAPSE_ADMIN_TOKEN', 'MATRIX_OWNER_ID', 'ANTHROPIC_BASE_URL', 'CLAUDECODE'];
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  for (const key of keys) process.env[key] = 'sentinel';
  f.state.update('conversation', { codex: 'existing-codex-thread' });
  assert.equal(await f.backend('claude', 'hello', 'conversation', signal(), '@owner:test'), 'Claude answer');
  assert.equal(await f.backend('claude', 'follow up', 'conversation', signal(), '@owner:test'), 'Claude answer');
  for (const call of f.calls().filter(call => call.args)) assert.deepEqual(call.secrets, []);
  const runs = f.calls().filter(call => call.args?.includes('--print'));
  assert.equal(runs.length, 2); assert.ok(!runs[0].args.includes('--resume'));
  assert.equal(runs[1].args[runs[1].args.indexOf('--resume') + 1], 'claude-session-1');
  const saved = new State(join(f.dir, 'state.json')).session('conversation');
  assert.equal(saved.codex, 'existing-codex-thread');
  assert.equal(saved.claude, 'claude-session-1');
  f.state.reset('conversation');
  assert.deepEqual(f.state.session('conversation'), {});
});

test('Claude readiness is checked once and re-checked after a failed task', async t => {
  const f = setup(t);
  const checks = () => f.calls().filter(call => call.args?.includes('--help')).length;
  await f.backend('claude', 'first', 'key', signal(), '@owner:test');
  await f.backend('claude', 'second', 'key', signal(), '@owner:test');
  assert.equal(checks(), 1);
  await assert.rejects(f.backend('claude', '[fail]', 'key', signal(), '@owner:test'));
  await f.backend('claude', 'retry', 'key', signal(), '@owner:test');
  assert.equal(checks(), 2);
});

test('Claude usage is read with the local /usage command and no tools', async t => {
  const f = setup(t);
  assert.equal(await claudeUsage(f.config, signal()), 'Current session: 13% used · resets 7:50pm');
  const call = f.calls().find(call => call.args?.includes('/usage'));
  assert.deepEqual(call.args.slice(0, 2), ['-p', '/usage']);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.deepEqual(call.secrets, []);
});

for (const kind of ['claude', 'codex'] as const) test(`!usage (${kind}) answers the owner during a task and refuses others and unsupported bots`, async t => {
  const f = setup(t);
  const replies: string[] = [];
  let release!: () => void;
  const running = new Promise<void>(resolve => { release = resolve; });
  const make = (usage?: (signal: AbortSignal) => Promise<string>) => new Bridge({
    botId: '@claude:test', kind, since: 0, timeoutMs: 5000, state: f.state, owner: '@owner:test',
    isAuthorized: user => user === '@owner:test' || user === '@guest:test', isPrivateRoom: async () => true,
    run: async () => { await running; return 'done'; }, usage,
    reply: async (_room, _event, text) => { replies.push(text); }, report: () => {},
  });
  let n = 0;
  const event = (sender: string, body: string): MatrixEvent => ({ type: 'm.room.message', event_id: '$' + n++, sender, origin_server_ts: 2000, content: { msgtype: 'm.text', body } });
  const bridge = make(signal => claudeUsage(f.config, signal));
  const task = bridge.handle('!dm:test', event('@owner:test', 'long task'));
  await bridge.handle('!dm:test', event('@owner:test', '!usage'));
  assert.equal(replies.at(-1), 'Current session: 13% used · resets 7:50pm');
  await bridge.handle('!dm:test', event('@guest:test', '!usage'));
  assert.match(replies.at(-1)!, /Only the initial owner/);
  await make().handle('!dm:test', event('@owner:test', '!usage'));
  assert.match(replies.at(-1)!, /not available for this bot/);
  release(); await task;
});

test('Claude permission prompts use stdio only for workspace-write bots with approvals enabled', async t => {
  const f = setup(t);
  assert.ok(!claudeArguments(f.config).includes('--permission-prompt-tool'));
  const args = claudeArguments(f.config, undefined, true);
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(claudeApprovals(f.config), true);
  assert.equal(claudeApprovals({ ...f.config, sandbox: 'read-only' }), false);
  assert.equal(claudeApprovals({ ...f.config, claudeApprovalPolicy: 'never' }), false);
});

for (const [name, decide, expected] of [
  ['approved', async (question: Interaction) => question.approve!, 'Permission allow'],
  ['declined', async (question: Interaction) => question.deny, 'Permission deny'],
  ['unconfirmable', async () => { throw new Error('Matrix unavailable'); }, 'Permission deny'],
] as const) {
  test('Claude permission request is ' + name + ' through Matrix and answered on stdin', async t => {
    const f = setup(t);
    let text = '';
    const interact: Interact = async question => { text = question.text; return decide(question); };
    assert.equal(await f.backend('claude', '[permission]', 'key', signal(), '@owner:test', [], interact), expected);
    assert.match(text, /use Bash/); assert.match(text, /Reason: Outside the sandbox/);
    assert.match(text, /Command: touch x/); assert.match(text, /Description: Create x/); assert.match(text, /"timeout": 5/);
    const run = f.calls().find(call => call.args?.includes('--print'));
    assert.equal(run.args[run.args.indexOf('--permission-prompt-tool') + 1], 'stdio');
    const { response } = f.calls().find(call => call.response);
    assert.equal(response.type, 'control_response');
    assert.equal(response.response.request_id, 'perm-1');
    assert.equal(response.response.response.behavior, expected === 'Permission allow' ? 'allow' : 'deny');
    if (expected === 'Permission allow') assert.deepEqual(response.response.response.updatedInput, { command: 'touch x', description: 'Create x', timeout: 5 });
  });
}

test('a permission request withdrawn by Claude expires in Matrix and is never answered', async t => {
  const f = setup(t);
  let expired = false;
  const interact: Interact = (_question, requestSignal) => new Promise((_resolve, reject) => {
    requestSignal.addEventListener('abort', () => { expired = true; reject(requestSignal.reason); });
  });
  assert.equal(await f.backend('claude', '[withdrawn]', 'key', signal(), '@owner:test', [], interact), 'withdrawn');
  assert.equal(expired, true);
  assert.ok(!f.calls().some(call => call.response));
});

test('unsupported Claude control requests fail closed without stopping the task', async t => {
  const f = setup(t);
  assert.equal(await f.backend('claude', '[unknown-control]', 'key', signal(), '@owner:test', [], async () => assert.fail('must not ask')), 'Unknown error');
});

test('a Matrix user approves a Claude permission request with !approve', async t => {
  const f = setup(t);
  const replies: string[] = [];
  let confirmation!: (text: string) => void;
  const asked = new Promise<string>(resolve => { confirmation = resolve; });
  const bridge = new Bridge({
    botId: '@claude:test', kind: 'claude', since: 0, timeoutMs: 5000, state: f.state,
    isAuthorized: user => user === '@owner:test', isPrivateRoom: async () => true,
    run: f.backend, steer: f.backend.steer,
    reply: async (_room, _event, text) => { replies.push(text); if (text.startsWith('Confirmation ')) confirmation(text); },
    report: () => assert.fail('Unexpected bridge error'),
  });
  const event = (id: string, body: string): MatrixEvent => ({ type: 'm.room.message', event_id: id, sender: '@owner:test', origin_server_ts: 2000, content: { msgtype: 'm.text', body } });
  const task = bridge.handle('!dm:test', event('$task', '[permission]'));
  const id = /^Confirmation ([a-f0-9]{12})/.exec(await asked)![1];
  await bridge.handle('!dm:test', event('$approve', '!approve ' + id));
  await task;
  assert.ok(replies.includes(`Answer sent for ${id}. This does not yet mean the action succeeded.`));
  assert.equal(replies.at(-1), 'Permission allow');
});

test('Claude permission arguments enable its sandbox without bypass and limit read-only tools', async t => {
  const f = setup(t);
  const args = claudeArguments({ ...f.config, claudeModel: 'sonnet' });
  assert.ok(!args.some(arg => arg.includes('skip-permissions') || arg.includes('bypassPermissions')));
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.equal(settings.sandbox.enabled, true); assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  const readOnly = claudeArguments({ ...f.config, sandbox: 'read-only' });
  assert.equal(readOnly[readOnly.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(readOnly[readOnly.indexOf('--permission-mode') + 1], 'dontAsk');
});

test('Claude receives native image content and file/audio paths and can return encrypted-delivery manifests', async t => {
  const f = setup(t);
  const imagePath = join(f.dir, 'image.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  writeFileSync(imagePath, png);
  const attachments = [
    { path: imagePath, name: 'image.png', image: true, mimetype: 'image/png', size: png.length },
    { path: join(f.dir, 'audio.ogg'), name: 'audio.ogg', image: false, mimetype: 'audio/ogg', size: 10 },
    { path: join(f.dir, 'notes.txt'), name: 'notes.txt', image: false, mimetype: 'text/plain', size: 10 },
  ];
  const reply = await f.backend('claude', '[attachment]', 'conversation', signal(), '@owner:test', attachments) as BackendReply;
  const input = f.calls().find(call => call.input).input;
  assert.equal(input.type, 'user'); assert.equal(input.message.role, 'user');
  assert.deepEqual(input.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
  assert.ok(input.message.content[0].text.includes(attachments[1].path)); assert.ok(input.message.content[0].text.includes(attachments[2].path));
  assert.equal(reply.text, 'Here is the file.'); assert.equal(readFileSync(reply.attachments[0].path, 'utf8'), 'Claude file');
});

test('oversized Claude image inputs fail before starting the model', async t => {
  const f = setup(t);
  const path = join(f.dir, 'big.png'); writeFileSync(path, Buffer.alloc(5 * 1024 * 1024 + 1));
  await assert.rejects(f.backend('claude', 'image', 'key', signal(), '@owner:test', [{ path, name: 'big.png', image: true, mimetype: 'image/png', size: 1 }]), /limit/);
  assert.ok(!f.calls().some(call => call.args?.includes('--print')));
});

for (const prompt of ['[fail]', '[bad-json]', '[no-result]', '[approval]']) {
  test('Claude fails safely for ' + prompt + ' and permits a later retry', async t => {
    const f = setup(t);
    await assert.rejects(f.backend('claude', prompt, 'key', signal(), '@owner:test'));
    assert.equal(await f.backend('claude', 'retry', 'key', signal(), '@owner:test'), 'Claude answer');
  });
}

test('Claude cancellation waits for the process to exit and releases its conversation', async t => {
  const f = setup(t);
  const abort = new AbortController();
  const task = f.backend('claude', '[wait]', 'key', abort.signal, '@owner:test');
  const stopped = assert.rejects(task);
  await until(() => f.calls().some(call => call.waiting));
  await assert.rejects(f.backend('claude', 'duplicate', 'key', signal(), '@owner:test'), /already running in this conversation/);
  assert.equal(await f.backend.steer('update', 'key', signal(), '@owner:test'), false);
  abort.abort(); await stopped;
  assert.ok(f.calls().some(call => call.stopped));
  assert.equal(await f.backend('claude', 'retry', 'key', signal(), '@owner:test'), 'Claude answer');
});

test('routing runs Claude alongside a running Codex task and isolates steering', async () => {
  let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  let codexSteers = 0, claudeRuns = 0;
  const codex = Object.assign((async () => { await done; return 'codex'; }) as Backend, { steer: async () => { codexSteers++; return true; } });
  const claude = Object.assign((async () => { claudeRuns++; return 'claude'; }) as Backend, { steer: async () => false });
  const router = routeBackends({ codex, claude });
  const task = router('codex', 'first', 'codex-room', signal(), '@owner:test');
  assert.equal(await router('claude', 'parallel', 'claude-room', signal(), '@owner:test'), 'claude');
  assert.equal(await router.steer('wrong room', 'claude-room', signal(), '@owner:test'), false);
  assert.equal(await router.steer('wrong sender', 'codex-room', signal(), '@guest:test'), false);
  assert.equal(await router.steer('correct', 'codex-room', signal(), '@owner:test'), true);
  finish(); await task;
  assert.equal(await router('claude', 'second', 'claude-room', signal(), '@owner:test'), 'claude');
  assert.equal(codexSteers, 1); assert.equal(claudeRuns, 2);
});

test('Claude updates during work are queued by Matrix bridge and resumed in the same Claude session', async t => {
  const f = setup(t);
  const replies: string[] = [];
  let release!: () => void, finished!: () => void;
  const firstResult = new Promise<void>(resolve => { finished = resolve; });
  const deliver = new Promise<void>(resolve => { release = resolve; });
  const bridge = new Bridge({
    botId: '@claude:test', kind: 'claude', since: 0, timeoutMs: 5000, state: f.state,
    isAuthorized: user => user === '@owner:test', isPrivateRoom: async () => true,
    run: f.backend, steer: f.backend.steer,
    queuedUpdateMessage: 'Queued for Claude after the current step.',
    reply: async (_room, event, text) => {
      replies.push(text);
      if (event.event_id === '$first' && text === 'Claude answer') { finished(); await deliver; }
    }, report: () => assert.fail('Unexpected bridge error'),
  });
  const event = (id: string, body: string): MatrixEvent => ({ type: 'm.room.message', event_id: id, sender: '@owner:test', origin_server_ts: 2000, content: { msgtype: 'm.text', body } });
  const task = bridge.handle('!dm:test', event('$first', 'first'));
  await firstResult;
  await bridge.handle('!dm:test', event('$update', 'make it blue'));
  release(); await task;
  assert.ok(replies.includes('Queued for Claude after the current step.'));
  assert.equal(replies.filter(text => text === 'Claude answer').length, 2);
  const runs = f.calls().filter(call => call.args?.includes('--print'));
  assert.equal(runs.length, 2); assert.ok(runs[1].args.includes('claude-session-1'));
  assert.equal(f.state.session(sessionKey('!dm:test', event('$first', 'first'))).claude, 'claude-session-1');
});

test('Claude provisioning creates a separate non-admin Matrix bot', async t => {
  const f = setup(t);
  let body: any;
  const fake = (async (url, init) => {
    if (String(url).endsWith('/whoami')) return Response.json({ user_id: '@admin:test' });
    if (init?.method === 'GET') return Response.json({}, { status: 404 });
    if (init?.method === 'PUT') { body = JSON.parse(String(init.body)); assert.match(String(url), /bot_claude_research_/); return Response.json({}); }
    return Response.json({ user_id: '@claude:test', access_token: 'bot-token', device_id: 'device' });
  }) as typeof fetch;
  const bot = await provision({ ...f.config, adminToken: 'test-admin' }, 'claude', 'Research', undefined, fake);
  assert.equal(bot.kind, 'claude'); assert.equal(body.admin, false);
});

test('Claude status uses init metadata, preserves unknowns and clears stale fields on resume', async t => {
  const f = setup(t);
  const backend = createBackend({ ...f.config, claudeModel: 'requested-alias' }, f.state);
  await backend('claude', 'hello', 'key', signal(), '@owner:test');
  const report = f.state.session('key').claudeReport!;
  assert.equal(report.model, 'resolved-claude');
  assert.equal(report.cwd, f.dir);
  assert.equal(report.permissionMode, 'acceptEdits');
  assert.equal(report.fastMode, 'off');
  assert.equal(report.reasoningEffort, undefined);
  assert.equal(report.serviceTier, undefined);
  assert.ok(Number.isFinite(Date.parse(report.reportedAt)));
  assert.equal(f.state.session('another-key').claudeReport, undefined);
  assert.deepEqual(new State(join(f.dir, 'state.json')).session('key').claudeReport, report);
  await backend('claude', '[missing-status]', 'key', signal(), '@owner:test');
  assert.deepEqual(Object.keys(f.state.session('key').claudeReport!), ['reportedAt']);
  f.state.reset('key');
  assert.equal(f.state.session('key').claudeReport, undefined);
});


test('Claude sends progress around tool use without duplicating final text or exposing thinking', async t => {
  const f = setup(t);
  const updates: string[] = [];
  const result = await f.backend('claude', '[progress]', 'progress-conversation', signal(), '@owner:test', [], undefined, undefined,
    { progress: async text => { updates.push(text); } });
  assert.deepEqual(updates, ['Checking the files.', 'Running the checks.']);
  assert.equal(typeof result === 'string' ? result : result.text, 'Claude answer');
});

test('Claude snapshots dynamic model settings and refreshes them on resume', async t => {
  const f = setup(t), settings = { ...f.config, claudeModel: 'first-model' };
  const backend = createBackend(() => settings, f.state);
  const first = backend('claude', 'hello', 'dynamic', signal(), '@owner:test');
  settings.claudeModel = 'second-model';
  await first;
  const invocation = () => f.calls().filter(c => c.args?.includes('--model')).at(-1).args as string[];
  assert.equal(invocation()[invocation().indexOf('--model') + 1], 'first-model');
  await backend('claude', 'hello again', 'dynamic', signal(), '@owner:test');
  const args = invocation();
  assert.equal(args[args.indexOf('--model') + 1], 'second-model');
  assert.equal(args[args.indexOf('--resume') + 1], 'claude-session-1');
});
