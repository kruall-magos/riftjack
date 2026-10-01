import { formatUsageTable, USAGE_COLUMNS } from './usage-table.js';

// Formats Claude Code's /usage text for Matrix as a table of the 5-hour and weekly limits.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export type UsagePeriod = { label: string; used: number; resetsAt?: Date; timeZone?: string; kind: 'session' | 'week' | 'other' };

// Offset of a time zone from UTC at the given instant, in milliseconds.
function zoneOffset(time: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(time)).map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - time;
}

function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone?: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  if (!timeZone) return new Date(year, month, day, hour, minute).getTime();
  // Two passes settle the offset across daylight-saving transitions.
  const first = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(first, timeZone);
}

function validZone(zone: string | undefined): string | undefined {
  if (!zone) return;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone; } catch { return; }
}

// Parses "Oct 4 at 2am (America/New_York)" or "7:50pm (America/New_York)"; the year is inferred.
export function parseReset(text: string, now: Date): { at: Date; timeZone?: string } | undefined {
  const match = /^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?$/i.exec(text.trim());
  if (!match) return;
  const [, monthName, dayText, hourText, minuteText = '0', meridiem, zoneText] = match;
  const timeZone = validZone(zoneText?.trim());
  const hour = Number(hourText) % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  const minute = Number(minuteText);
  const today = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(now).map(part => [part.type, Number(part.value)]));
  if (monthName) {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    if (month < 0) return;
    let at = zonedTime(today.year, month, Number(dayText), hour, minute, timeZone);
    // A reset is always in the future; a date that already passed belongs to next year.
    if (at < now.getTime() - DAY) at = zonedTime(today.year + 1, month, Number(dayText), hour, minute, timeZone);
    return { at: new Date(at), timeZone };
  }
  let at = zonedTime(today.year, today.month - 1, today.day, hour, minute, timeZone);
  if (at < now.getTime()) at = zonedTime(today.year, today.month - 1, today.day + 1, hour, minute, timeZone);
  return { at: new Date(at), timeZone };
}

export function parseUsage(text: string, now: Date): UsagePeriod[] {
  const periods: UsagePeriod[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/i.exec(line);
    if (!match) continue;
    const reset = match[3] ? parseReset(match[3], now) : undefined;
    const label = match[1].trim();
    const kind = /session/i.test(label) ? 'session' : /week/i.test(label) ? 'week' : 'other';
    periods.push({ label, used: Number(match[2]), resetsAt: reset?.at, timeZone: reset?.timeZone, kind });
  }
  return periods;
}

export function formatClaudeUsage(text: string, now = new Date()): string {
  const periods = parseUsage(text, now);
  if (!periods.some(period => period.kind === 'session' || period.kind === 'week')) {
    return '### Claude usage limits\n\n_Claude Code returned no usage limits; the server may be unreachable. Try !usage again later._\n\n```\n' + text.replace(/```/g, '`\u200b``') + '\n```';
  }
  const lines = ['### Claude usage limits', '', formatUsageTable(periods, USAGE_COLUMNS, now), ''];
  // Claude Code's own explanation of what contributes to usage, kept verbatim.
  const details = text.split('\n').filter(line => !/%\s*used/i.test(line) && !/^You are currently using/i.test(line)).join('\n').trim();
  if (details) lines.push('#### Details from Claude Code', '', details.replace(/^(\s*)([-*+>#])/gm, '$1\\$2'));
  return lines.join('\n').trim();
}
