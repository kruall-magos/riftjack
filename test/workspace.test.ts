import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { configForWorkspace, creationWorkspace, resolveWorkspace } from '../src/workspace.js';
import { Accounts, parseManagerRequest } from '../src/accounts.js';

test('shared workspace configuration requires a valid working directory', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-config-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'My Project'); mkdirSync(project);
  const alias = join(root, 'alias'); symlinkSync(project, alias);
  const env = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test' };
  assert.equal(loadConfig({ ...env, RIFTJACK_WORKSPACE: ` ${alias} ` }).workspace, project);
  assert.throws(() => loadConfig(env), /Set RIFTJACK_WORKSPACE/);
  assert.throws(() => loadConfig({ ...env, RIFTJACK_WORKSPACE: ' ' }), /Set RIFTJACK_WORKSPACE/);
  const file = join(root, 'file'); writeFileSync(file, 'not a directory');
  assert.throws(() => loadConfig({ ...env, RIFTJACK_WORKSPACE: file }), /RIFTJACK_WORKSPACE must be a directory/);
  assert.throws(() => loadConfig({ ...env, RIFTJACK_WORKSPACE: join(root, 'missing') }), { code: 'ENOENT' });
});

test('creation accepts Codex and Claude workspace paths, including spaces and punctuation', () => {
  for (const engine of ['Codex', 'Claude', 'Claude Code']) {
    assert.deepEqual(parseManagerRequest(`create a ${engine} bot called Builder in "/projects/My Project"`),
      { action: 'create', kind: engine === 'Codex' ? 'codex' : 'claude', name: 'Builder', workspace: '/projects/My Project' });
  }
  assert.equal((parseManagerRequest('create a Codex bot in ~/Projects/site') as { workspace: string }).workspace, '~/Projects/site');
  assert.equal((parseManagerRequest("create a Claude bot called Builder in '/projects/name.'") as { workspace: string }).workspace, '/projects/name.');
  assert.equal((parseManagerRequest('create a Codex bot in /projects/name.') as { workspace: string }).workspace, '/projects/name.');
  assert.equal(parseManagerRequest('create a Codex bot in ""'), null);
  assert.equal(parseManagerRequest('create a Codex bot in "/project\\nother"'), null);
  assert.equal(parseManagerRequest('list bots in /projects'), null);
  assert.equal(parseManagerRequest('create a Codex bot in "/projects/unterminated'), null);
  assert.deepEqual(parseManagerRequest('create a Codex bot called Builder in Blue'), { action: 'create', kind: 'codex', name: 'Builder', workspace: 'Blue' });
});

test('last spaced in separates an unquoted workspace, with optional quotes for paths containing in', () => {
  for (const engine of ['Codex', 'Claude', 'Claude Code']) {
    const kind = engine === 'Codex' ? 'codex' : 'claude';
    for (const workspace of ['demo', 'My Project', '/projects/My Project', '~/My Project', '../demo', './demo']) {
      assert.deepEqual(parseManagerRequest(`create a ${engine} bot called Builder in ${workspace}`),
        { action: 'create', kind, name: 'Builder', workspace });
    }
    assert.deepEqual(parseManagerRequest(`create a ${engine} bot called Alice in Wonderland in demo`),
      { action: 'create', kind, name: 'Alice in Wonderland', workspace: 'demo' });
    assert.deepEqual(parseManagerRequest(`create a ${engine} bot IN demo`),
      { action: 'create', kind, name: engine === 'Codex' ? 'Codex' : 'Claude', workspace: 'demo' });
  }
  for (const quote of ['"', "'"]) {
    assert.equal((parseManagerRequest(`create a Codex bot called Builder in ${quote}Projects in progress${quote}`) as { workspace: string }).workspace, 'Projects in progress');
    assert.equal(parseManagerRequest(`create a Codex bot in ${quote}unfinished`), null);
  }
  assert.deepEqual(parseManagerRequest('create a Codex bot called Linkedin'), { action: 'create', kind: 'codex', name: 'Linkedin' });
  assert.equal(parseManagerRequest('list bots in demo'), null);
});

test('workspace paths preserve Unicode scripts, combining marks and emoji', () => {
  for (const workspace of ['Проект Демо', 'デモ 計画', 'مشروع تجريبي', 'Cafe\u0301', 'demo 🚀']) {
    assert.deepEqual(parseManagerRequest(`create a Codex bot called Builder in "${workspace}"`),
      { action: 'create', kind: 'codex', name: 'Builder', workspace });
  }
});

test('custom workspaces are canonical, owner-only and persist without changing default accounts', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'matrix-workspace-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'My Project'); mkdirSync(project);
  const alias = join(root, 'alias'); symlinkSync(project, alias);
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: root });
  const approve = async () => ({ approved: true });
  const signal = new AbortController().signal;
  assert.equal(await creationWorkspace(config, alias, '@owner:test', approve, signal), project);
  assert.equal(resolveWorkspace('My Project', root), project);
  assert.equal(resolveWorkspace('~/', root), realpathSync(homedir()));
  await assert.rejects(creationWorkspace(config, project, '@guest:test', approve, signal), /Only the initial owner/);
  assert.equal(await creationWorkspace(config, undefined, '@guest:test', approve, signal), undefined);
  assert.equal(configForWorkspace(config), config);
  const selected = configForWorkspace(config, project);
  assert.equal(selected.workspace, project); assert.equal(config.workspace, root);
  assert.equal(selected.sandbox, config.sandbox);
  const file = join(root, 'accounts.json');
  const accounts = new Accounts(file);
  accounts.add({ userId: '@old:test', accessToken: 'test', name: 'Old', kind: 'codex' });
  accounts.add({ userId: '@new:test', accessToken: 'test', name: 'New', kind: 'claude', workspace: project });
  const restored = new Accounts(file).list();
  assert.equal(restored[0].workspace, undefined); assert.equal(restored[1].workspace, project);
});

test('workspace creation waits for consent, supports decline and creates nested relative paths', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'matrix-workspace-confirm-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: root });
  const signal = new AbortController().signal;
  const target = join(root, 'demo', 'project');
  const declined = await creationWorkspace(config, 'demo/project', config.owner, async request => {
    // Consent must distinguish creating a folder from using existing files.
    assert.match(request.text, /does not exist yet/);
    assert.ok(request.text.includes(target));
    assert.equal(existsSync(target), false);
    return request.deny;
  }, signal);
  assert.equal(declined, null);
  assert.equal(existsSync(join(root, 'demo')), false);
  const approved = await creationWorkspace(config, 'demo/project', config.owner, async request => {
    assert.equal(existsSync(target), false);
    return request.approve!;
  }, signal);
  assert.equal(approved, target);
  assert.equal(existsSync(target), true);
  writeFileSync(join(target, 'keep.txt'), 'keep');
  assert.equal(await creationWorkspace(config, target, config.owner, async request => {
    assert.match(request.text, /already exists/);
    assert.ok(request.text.includes(target));
    assert.equal(existsSync(target), true);
    return request.deny;
  }, signal), null);
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep');
  await creationWorkspace(config, undefined, '@guest:test', async request => {
    assert.ok(request.text.includes(root));
    assert.equal(existsSync(root), true);
    return request.approve!;
  }, signal);
});

test('workspace confirmation aborts safely and rechecks changed destinations', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'matrix-workspace-recheck-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: root });
  const controller = new AbortController();
  await assert.rejects(creationWorkspace(config, 'cancelled', config.owner, async request => {
    controller.abort();
    return request.approve!;
  }, controller.signal), /abort/i);
  assert.equal(existsSync(join(root, 'cancelled')), false);
  const signal = new AbortController().signal;
  let asked = 0;
  assert.equal(await creationWorkspace(config, 'appeared', config.owner, async request => {
    if (++asked === 1) {
      assert.ok(request.text.includes(join(root, 'appeared')));
      assert.equal(existsSync(join(root, 'appeared')), false);
      mkdirSync(join(root, 'appeared'));
      return request.approve!;
    }
    assert.ok(request.text.includes(join(root, 'appeared')));
    assert.equal(existsSync(join(root, 'appeared')), true);
    return request.deny;
  }, signal), null);
  assert.equal(asked, 2);
  writeFileSync(join(root, 'file'), 'data');
  await assert.rejects(creationWorkspace(config, 'file', config.owner, async () => {
    assert.fail('a file must not be offered as a workspace');
  }, signal), /is a file/);
  await assert.rejects(creationWorkspace(config, 'missing', config.owner, undefined, signal), /confirmation/);
  assert.equal(existsSync(join(root, 'missing')), false);
});

test('missing or invalid workspaces fail instead of silently using the connector directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'matrix-workspace-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file'), 'content');
  for (const input of ['missing', 'file', '$HOME/nonexistent', '$(touch pwned)']) assert.throws(() => resolveWorkspace(input, root), /does not exist/);
  for (const input of ['', 'bad\0path', 'one\ntwo']) assert.throws(() => resolveWorkspace(input, root), /non-empty local directory/);
  const registry = join(root, 'accounts.json');
  writeFileSync(registry, JSON.stringify([{ userId: '@bot:test', accessToken: 'test', name: 'Bot', kind: 'codex', workspace: 42 }]));
  assert.throws(() => new Accounts(registry), /Invalid accounts/);
});
