import { AppServer } from './app-server.js';
import type { Config } from './config.js';
import { PublicError } from './errors.js';
import { formatUsageTable, USAGE_COLUMNS } from './usage-table.js';

type Window = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
type Limits = { limitId?: string | null; primary?: Window | null; secondary?: Window | null };
export type CodexRateLimits = {
  rateLimits?: Limits | null;
  rateLimitsByLimitId?: Record<string, Limits> | null;
  rateLimitResetCredits?: { availableCount: number } | null;
};

export function formatCodexUsage(result: CodexRateLimits, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const limits = result.rateLimitsByLimitId?.codex
    ?? (!result.rateLimits?.limitId || result.rateLimits.limitId === 'codex' ? result.rateLimits : undefined);
  // Weekly limits may appear in either slot. Other model/product buckets are not Codex quota.
  const week = [limits?.primary, limits?.secondary].find(window => window?.windowDurationMins === 10080
    && Number.isFinite(window.usedPercent) && window.usedPercent >= 0);
  const resetsAt = typeof week?.resetsAt === 'number' && Number.isFinite(week.resetsAt)
    ? new Date(week.resetsAt * 1000) : undefined;
  const reset = resetsAt && Number.isFinite(resetsAt.getTime()) ? resetsAt : undefined;
  const periods = week ? [{ kind: 'week', used: week.usedPercent, resetsAt: reset }] : [];
  const resetDate = reset && reset > now ? new Intl.DateTimeFormat('en-US', {
    timeZone, dateStyle: 'long', timeStyle: 'short',
  }).format(reset) + ` (${timeZone})` : 'unavailable';
  // The count is authoritative: the service can omit or truncate individual credit details.
  const count = result.rateLimitResetCredits?.availableCount;
  const available = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? String(count) : 'unavailable';
  return ['### Codex usage limits', '', week
    ? formatUsageTable(periods, USAGE_COLUMNS.filter(spec => spec.kind === 'week'), now)
    : 'Weekly limit unavailable. Try !usage again later.',
    '', `Next weekly reset: ${resetDate}.`,
    `Additional resets available: ${available}.`,
    '', 'Shared ChatGPT account limit across all Codex bots.'].join('\n');
}

// Read account metadata only: no model turn, API-key fallback or quota reset.
export async function codexUsage(config: Config, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const server = new AppServer(config, () => {}, () => {});
  const abort = () => { void server.close(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await server.initialize();
    const auth = await server.request<{ account?: { type: string } }>('account/read', { refreshToken: false });
    signal.throwIfAborted();
    if (auth.account?.type !== 'chatgpt') throw new PublicError('Sign in to Codex with your ChatGPT account to use !usage.');
    const result = await server.request<CodexRateLimits>('account/rateLimits/read', {});
    signal.throwIfAborted();
    return formatCodexUsage(result);
  } finally {
    signal.removeEventListener('abort', abort);
    await server.close();
  }
}
