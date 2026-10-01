import type { Account } from './accounts.js';

// Escape literal user-supplied names, IDs and paths before composing Markdown.
export const markdownText = (value: string): string => value.replace(/[^\p{L}\p{N}\s]/gu,
  char => char === '&' ? '&amp;' : `&#${char.codePointAt(0)};`);
export function inlineCode(value: string): string {
  const fence = '`'.repeat(Math.max(0, ...(value.match(/`+/g) || []).map(run => run.length)) + 1);
  return `${fence} ${value} ${fence}`;
}

export function managerBotList(accounts: Account[], defaultWorkspace: string): string {
  return '### Bots\n\n' + (accounts.length ? accounts.map(account => [
    `**${markdownText(account.name)}** · ${inlineCode(account.kind)}`,
    `Matrix ID: ${inlineCode(account.userId)}`,
    ...(account.kind === 'manager' ? [] : account.kind === 'grok' ? ['Execution: external worker'] : [`Workspace: ${inlineCode(account.workspace || defaultWorkspace)}`]),
  ].join('\n')).join('\n\n') : 'No bots yet.');
}
