import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClaudeUsage, parseReset, parseUsage } from '../src/claude-usage.js';

const now = new Date('2026-09-30T19:55:00Z'); // 3:55pm in New York (EDT, UTC-4)
const sample = `You are currently using your subscription to power your Claude Code usage

Current session: 19% used · resets Sep 30 at 7:49pm (America/New_York)
Current week (all models): 5% used · resets Oct 4 at 1:59am (America/New_York)

What's contributing to your limits usage?
Last 24h · 110 requests · 1 session
  75% of your usage was at >150k context`;

test('reset times are read in their own time zone, with the year and day inferred', () => {
  assert.equal(parseReset('Oct 4 at 1:59am (America/New_York)', now)!.at.toISOString(), '2026-10-04T05:59:00.000Z');
  assert.equal(parseReset('Sep 30 at 7:49pm (America/New_York)', now)!.at.toISOString(), '2026-09-30T23:49:00.000Z');
  assert.equal(parseReset('Jan 2 at 3pm (UTC)', new Date('2026-12-30T12:00:00Z'))!.at.toISOString(), '2027-01-02T15:00:00.000Z');
  // A bare time that already passed today means tomorrow.
  assert.equal(parseReset('2am (UTC)', new Date('2026-09-30T10:00:00Z'))!.at.toISOString(), '2026-10-01T02:00:00.000Z');
  assert.equal(parseReset('12am (Not/AZone)', now)?.timeZone, undefined);
  assert.equal(parseReset('tomorrow', now), undefined);
});

test('usage lines are classified by period', () => {
  assert.deepEqual(parseUsage(sample, now).map(period => [period.kind, period.used]), [['session', 19], ['week', 5]]);
});

const row = (text: string, name: string) => text.split('\n').find(line => line.startsWith('| ' + name))!.split('|').slice(2, 4).map(cell => cell.trim());

test('the 5-hour and weekly limits are shown as an aligned table', () => {
  const text = formatClaudeUsage(sample, now);
  assert.match(text, /^### Claude usage limits/);
  assert.deepEqual(row(text, 'Remaining'), ['5 h', '7 d']);
  assert.deepEqual(row(text, 'Time'), ['3 h 54 min', '3 d 10 h']);
  assert.deepEqual(row(text, 'Quota'), ['81%', '95%']);
  // Compare remaining pace with an even 100% over each period.
  assert.deepEqual(row(text, 'Target'), ['20.8%/h', '27.8%/d']);
  assert.deepEqual(row(text, 'Pace ratio'), ['1.04', '1.94']);
  assert.match(text, /#### Details from Claude Code[\s\S]*75% of your usage/);
  assert.doesNotMatch(text, /You are currently using|Monthly/);
});

test('shares are always shown with two decimals, including tiny, exhausted and final-hour limits', () => {
  const at = new Date('2026-09-30T14:00:00Z');
  const week = (used: number) => row(formatClaudeUsage(`Current week (all models): ${used}% used · resets Oct 4 at 2am (UTC)`, at), 'Pace ratio')[1];
  assert.equal(week(90), '0.20');
  assert.equal(week(99), '0.02');
  assert.equal(week(100), '0.00');
  // 30% left with 30 minutes to go: 60%/h against 20%/h.
  const lastHalfHour = formatClaudeUsage('Current session: 70% used · resets 2:30pm (UTC)', at);
  assert.deepEqual(row(lastHalfHour, 'Time'), ['30 min', '—']);
  assert.deepEqual(row(lastHalfHour, 'Target'), ['60%/h', '—']);
  assert.deepEqual(row(lastHalfHour, 'Pace ratio'), ['3.00', '—']);
  assert.deepEqual(row(formatClaudeUsage('Current session: 19% used · resets 6:30pm (UTC)', at), 'Pace ratio'), ['0.90', '—']);
});

test('output without limit lines is shown verbatim with an explanation', () => {
  const text = formatClaudeUsage("What's contributing to your limits usage?\n```inject```", now);
  assert.match(text, /returned no usage limits/);
  assert.doesNotMatch(text, /\| Remaining/);
  assert.match(text, /```\nWhat's contributing/);
  assert.equal(text.match(/```/g)!.length, 2);
});
