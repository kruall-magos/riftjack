import { inlineCode, markdownText } from './manager-format.js';

type Detail = { label?: string; value: string; code?: boolean };

// Compose both presentations from the same values. Tool input is literal text,
// never Markdown: even a command containing fences must stay inside its block.
export function confirmationDetails(details: Detail[]): { text: string; markdown: string } {
  return {
    text: details.map(({ label, value }) => `${label ? label + ': ' : ''}${value}`).join('\n'),
    markdown: details.map(({ label, value, code }) => {
      const title = label ? `**${markdownText(label)}:**\n` : '';
      if (!code) return title + markdownText(value);
      const fence = '`'.repeat(Math.max(2, ...(value.match(/`+/g) || []).map(run => run.length)) + 1);
      return `${title}\n${fence}text\n${value}\n${fence}`;
    }).join('\n\n'),
  };
}

export function confirmationPrompt(id: string, request: {
  text: string; markdown?: string; approve?: object; answer?: unknown; answerHint?: string;
}): { text: string; markdown: string } {
  const actions = [
    ...(request.approve !== undefined ? [{ label: '✅ Approve', command: `!approve ${id}` }] : []),
    { label: '❌ Decline', command: `!deny ${id}` },
    ...(request.answer ? [{ label: 'Answer', command: `!answer ${id} ${request.answerHint || '<answer>'}` }] : []),
  ];
  const hint = 'React below or send a command. ID optional when only one request is pending.';
  return {
    text: `Confirmation ${id}\n${request.text}\n\n` +
      actions.map(a => `${a.label}: ${a.command}`).join('\n') + '\n' + hint,
    markdown: `### Confirmation ${inlineCode(id)}\n\n${request.markdown ?? markdownText(request.text)}\n\n` +
      actions.map(a => `${a.label}: ${inlineCode(a.command)}`).join('\n') + '\n\n' + hint,
  };
}
