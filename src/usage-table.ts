const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const number = (value: number, digits = 1) => value.toLocaleString('en-US', { maximumFractionDigits: digits });

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  if (days) return hours ? `${days} d ${hours} h` : `${days} d`;
  if (hours) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  return `${rest} min`;
}

// Column values for one limit. The target pace spends the remaining quota exactly by the reset;
// its share compares that pace with spending 100% evenly over the whole period.
type Column = { left: string; quota: string; target: string; share: string };
export const USAGE_COLUMNS = [
  { kind: 'session', title: '5 h', length: 5 * HOUR, unit: HOUR, per: '/h' },
  { kind: 'week', title: '7 d', length: 7 * DAY, unit: DAY, per: '/d' },
] as const;

function column(period: { used: number; resetsAt?: Date } | undefined, spec: typeof USAGE_COLUMNS[number], now: Date): Column {
  if (!period) return { left: '—', quota: '—', target: '—', share: '—' };
  const remaining = Math.max(0, 100 - period.used);
  const quota = `${number(remaining)}%`;
  const left = period.resetsAt && period.resetsAt.getTime() - now.getTime();
  if (!left || left <= 0) return { left: '—', quota, target: '—', share: '—' };
  const target = remaining / (left / spec.unit);
  const share = target / (100 / (spec.length / spec.unit));
  return { left: duration(left), quota, target: `${number(target)}%${spec.per}`,
    share: share.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) };
}

// Padded so the Markdown source is readable; the formatter redraws it as a box table.
function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => Array.from(row[i]).length)));
  const line = (row: string[]) => '| ' + row.map((cell, i) => cell + ' '.repeat(widths[i] - Array.from(cell).length)).join(' | ') + ' |';
  return [line(rows[0]), '|' + widths.map(width => '-'.repeat(width + 2)).join('|') + '|', ...rows.slice(1).map(line)].join('\n');
}

export function formatUsageTable(periods: { used: number; resetsAt?: Date; kind: string }[], specs: readonly (typeof USAGE_COLUMNS[number])[], now: Date): string {
  const columns = specs.map(spec => column(periods.find(period => period.kind === spec.kind), spec, now));
  return table([
    ['Remaining', ...specs.map(spec => spec.title)],
    ['Time', ...columns.map(c => c.left)],
    ['Quota', ...columns.map(c => c.quota)],
    ['Target', ...columns.map(c => c.target)],
    ['Pace ratio', ...columns.map(c => c.share)],
  ]);
}
