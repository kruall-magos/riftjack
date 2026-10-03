import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/accounts.js';
import { loadConfig } from '../src/config.js';
import { manageBotSettings, parseBotSettingsRequest } from '../src/bot-settings.js';
import { withEngineSettings } from '../src/engine-settings.js';
import { botStatus } from '../src/bot-status.js';

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'accounts.json');
  const accounts = new Accounts(file);
  for (const kind of ['codex', 'claude', 'grok', 'manager'] as const) accounts.add({
    userId: `@${kind}:test`, name: kind, kind, accessToken: 'test-token', inviteUserId: '@creator:test',
  });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test',
    RIFTJACK_WORKSPACE: dir, CODEX_MODEL: 'shared-model', CODEX_REASONING_EFFORT: 'high', CODEX_SERVICE_TIER: 'default', CLAUDE_MODEL: 'shared-claude' });
  const options = { accounts, config, sender: '@owner:test', owner: '@owner:test' };
  const run = (text: string, sender = options.sender) => manageBotSettings(parseBotSettingsRequest(text)!, { ...options, sender });
  return { file, accounts, config, run };
}

test('settings commands support quoted names and reject incomplete or malformed commands', () => {
  assert.deepEqual(parseBotSettingsRequest('set model bot "Ready to work" to example-model'),
    { action: 'set', field: 'model', target: 'Ready to work', value: 'example-model' });
  assert.equal(parseBotSettingsRequest('list bots'), null);
  for (const bad of ['set model bot', 'set model bot Builder', 'set model bot Builder to', 'reset tier bot Builder to default', 'show settings bot']) {
    assert.throws(() => parseBotSettingsRequest(bad), /Use /);
  }
});

test('settings persist per bot, inherit defaults, reset one field and appear in status', t => {
  const f = setup(t);
  f.run('set model bot codex to personal-model', '@creator:test');
  f.run('set reasoning bot codex to medium');
  f.run('set tier bot codex to priority');
  f.run('set model bot claude to personal-claude');
  const accounts = new Accounts(f.file);
  const codex = accounts.list()[0];
  const effective = withEngineSettings(f.config, codex);
  assert.equal(effective.codexModel, 'personal-model');
  assert.equal(effective.codexReasoningEffort, 'medium');
  assert.equal(effective.codexServiceTier, 'priority');
  assert.equal(effective.claudeModel, 'shared-claude');
  assert.match(botStatus('codex', effective, {}), /personal\\-model/);
  assert.equal(withEngineSettings(f.config, accounts.list()[1]).claudeModel, 'personal-claude');
  assert.equal(withEngineSettings(f.config, { kind: 'codex' }).codexModel, 'shared-model');
  codex.engineSettings!.model = 'mutated-copy';
  assert.equal(accounts.list()[0].engineSettings!.model, 'personal-model');
  const reset = f.run('reset model bot codex');
  assert.match(reset, /shared-model.*inherited/);
  assert.match(reset, /priority.*bot override/);
  assert.equal(f.accounts.list()[0].engineSettings!.model, undefined);
  assert.equal(f.config.codexModel, 'shared-model');
  const before = readFileSync(f.file, 'utf8');
  assert.match(f.run('show settings bot codex'), /medium/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('authorization, unsupported engines and invalid values leave settings untouched', t => {
  const f = setup(t), before = readFileSync(f.file, 'utf8');
  assert.throws(() => f.run('set model bot codex to example', '@other:test'), /Only/);
  for (const text of ['set model bot grok to example', 'set model bot manager to example', 'set tier bot claude to default',
    'reset reasoning bot claude', 'set model bot codex to --flag', 'set model bot codex to ' + 'x'.repeat(129)]) assert.throws(() => f.run(text));
  assert.equal(readFileSync(f.file, 'utf8'), before);
  f.accounts.add({ ...f.accounts.list()[0], userId: '@duplicate:test' });
  assert.throws(() => f.run('set model bot codex to example'), /Several bots/);
  assert.match(f.run('set model bot @codex:test to example'), /example/);
});

test('malformed stored settings fail validation on startup', t => {
  const f = setup(t), original = JSON.parse(readFileSync(f.file, 'utf8'));
  for (const settings of [null, [], { model: '' }, { model: 123 }, { model: 'line\nbreak' }, { typo: 'x' }]) {
    const data = structuredClone(original); data[0].engineSettings = settings;
    writeFileSync(f.file, JSON.stringify(data));
    assert.throws(() => new Accounts(f.file));
  }
  original[1].engineSettings = { reasoning: 'high' };
  writeFileSync(f.file, JSON.stringify(original));
  assert.throws(() => new Accounts(f.file));
});
