import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCodexUsage } from '../src/codex-usage.js';

const now = new Date('2026-09-30T20:00:00Z');
const week = { usedPercent: 18, windowDurationMins: 10080, resetsAt: now.getTime() / 1000 + 6 * 86400 };

test('reset information includes local date, explicit time zone and available count', () => {
  const output = formatCodexUsage({ rateLimits: { primary: week }, rateLimitResetCredits: { availableCount: 4 } }, now, 'America/New_York');
  assert.match(output, /Next weekly reset: October 6, 2026 at 4:00 PM \(America\/New_York\)/);
  assert.match(output, /Additional resets available: 4\./);
});

test('reset count is independent of weekly data and distinguishes zero from unavailable', () => {
  assert.match(formatCodexUsage({ rateLimitResetCredits: { availableCount: 0 } }, now), /Additional resets available: 0\./);
  assert.match(formatCodexUsage({ rateLimitResetCredits: { availableCount: 4 } }, now), /Additional resets available: 4\./);
  for (const rateLimitResetCredits of [undefined, null, { availableCount: -1 }, { availableCount: NaN }, { availableCount: 1.5 }]) {
    assert.match(formatCodexUsage({ rateLimitResetCredits }, now), /Additional resets available: unavailable\./);
  }
  for (const resetsAt of [null, Infinity, now.getTime() / 1000 - 1]) {
    assert.match(formatCodexUsage({ rateLimits: { primary: { ...week, resetsAt } } }, now), /Next weekly reset: unavailable\./);
  }
});

test('Codex weekly table shares Claude rows and calculates remaining pace', () => {
  const output = formatCodexUsage({ rateLimits: { primary: week } }, now);
  assert.match(output, /\| Remaining\s*\| 7 d\s*\|/);
  assert.match(output, /\| Time\s*\| 6 d\s*\|/);
  assert.match(output, /\| Quota\s*\| 82%\s*\|/);
  assert.match(output, /\| Target\s*\| 13\.7%\/d\s*\|/);
  assert.match(output, /\| Pace ratio\s*\| 0\.96\s*\|/);
  assert.doesNotMatch(output, /5 h/);
});

test('weekly duration identifies either window; Codex bucket takes precedence', () => {
  assert.equal(formatCodexUsage({ rateLimits: { secondary: week } }, now),
    formatCodexUsage({ rateLimitsByLimitId: { codex: { primary: week } }, rateLimits: { primary: { ...week, usedPercent: 99 } } }, now));
  for (const result of [{}, { rateLimits: { limitId: 'other', primary: week } },
    { rateLimits: { primary: { ...week, windowDurationMins: 300 } } },
    { rateLimits: { primary: { ...week, usedPercent: NaN } } }]) {
    assert.match(formatCodexUsage(result, now), /Weekly limit unavailable/);
  }
});

test('missing or expired reset never produces a fictitious target; exhaustion stays zero', () => {
  for (const resetsAt of [null, now.getTime() / 1000 - 1, Infinity]) {
    const output = formatCodexUsage({ rateLimits: { primary: { ...week, resetsAt } } }, now);
    assert.match(output, /\| Target\s*\| —\s*\|/);
    assert.match(output, /\| Quota\s*\| 82%\s*\|/);
  }
  const output = formatCodexUsage({ rateLimits: { primary: { ...week, usedPercent: 100 } } }, now);
  assert.match(output, /\| Quota\s*\| 0%\s*\|/);
  assert.match(output, /\| Pace ratio\s*\| 0\.00\s*\|/);
});
