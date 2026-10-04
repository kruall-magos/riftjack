// App Server may propose a prefix even when the agent omitted prefix_rule.
// Carry the agent's deliberate choice through its justification instead. This
// is intent metadata, not a command-safety classifier or human authorization.
export const SAVE_INTENT = 'Riftjack-Persist: ';

export function approvalIntent(reason: unknown): { reason?: string; prefix?: string[] } {
  if (typeof reason !== 'string') return {};
  const lines = reason.trimEnd().split(/\r?\n/);
  const markers = lines.filter(line => line.startsWith(SAVE_INTENT));
  if (markers.length !== 1 || lines.at(-1) !== markers[0]) return { reason };
  const explanation = lines.slice(0, -1).join('\n').trim();
  if (!explanation) return { reason };
  try {
    const prefix: unknown = JSON.parse(markers[0].slice(SAVE_INTENT.length));
    if (Array.isArray(prefix) && prefix.length && prefix.every(arg => typeof arg === 'string' && arg.length && !arg.includes('\0'))) {
      return { reason: explanation, prefix: [...prefix] };
    }
  } catch {}
  return { reason };
}
