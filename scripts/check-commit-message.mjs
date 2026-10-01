import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Standard author trailers and known English attribution templates.
// This heuristic does not interpret arbitrary natural-language credits.
const agents = String.raw`(?:claude|codex|chatgpt|gpt(?:[ -]?[0-9]+(?:\.[0-9]+)?)?|github[\s-]+copilot|copilot|cursor|aider|gemini|cline|roo[\s-]*code|windsurf|devin|openhands|swe[\s-]*agent|amazon\s+q|tabnine|replit|augment|junie|qwen|kimi|grok|openai|anthropic|AI|LLM)`;
const agent = new RegExp(String.raw`(?<![\p{L}\p{N}])${agents}(?![\p{L}\p{N}])`, 'iu');
const attribution = /(?:generated|created|written|authored|committed|implemented|produced|built|developed|assisted|powered|suggested)\s+(?:by|with|using)/iu;

export function violations(message) {
  const text = message.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
  const result = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim().replace(/^[^\p{L}\p{N}]+/u, '');
    let rule;
    const trailer = /^(?:co[ -]?authored[ -]?by|(?:co[ -]?)?author|committed[ -]?by|generated[ -]?by|assisted[ -]?by|signed[ -]?off[ -]?by)\s*:\s*(.*)/i.exec(line);
    const credit = trailer?.[1].replace(/<[^>]*>/g, '').trim() || '';
    const aiName = new RegExp(String.raw`^${agents}(?:$|\s*\(|\s+(?:code|app|assistant|agent|bot|opus|sonnet|haiku|[0-9])\b)`, 'iu').test(credit);
    const aiEmail = /<(?:noreply@anthropic\.com|codex@openai\.com|aider@aider\.chat|cursoragent@cursor\.com|(?:\d+\+)?copilot(?:\[bot\])?@users\.noreply\.github\.com)>/i.test(trailer?.[1] || '');
    if (trailer && (aiName || aiEmail)) rule = 'AI author trailer';
    else if (/^aider\s*:/i.test(line)) rule = 'aider commit prefix';
    else if (new RegExp(String.raw`^(?:${agents})[ -]+(?:generated|authored|assisted)\b`, 'iu').test(line)) rule = 'AI attribution';
    else {
      // A separate footer or an explicitly delimited suffix; ordinary "fix: Claude integration" is valid.
      const pieces = line.split(/\s+[—–|]\s+|\s+\(/);
      if (pieces.some(rawPiece => {
        const piece = rawPiece.replace(/^this\s+(?:commit|change|code|patch|implementation)\s+(?:(?:was|is)\s+)?/i, '');
        const match = attribution.exec(piece);
        return match && match.index === 0 && agent.test(piece.slice(match[0].length));
      })) rule = 'AI attribution';
    }
    if (rule) result.push({ line: index + 1, rule });
  }
  return result;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
function commit(ref) {
  return git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}').trim();
}
function checkMessage(message, label) {
  const errors = violations(message);
  for (const error of errors) console.error(`${label}:${error.line}: ${error.rule}. Remove the AI credit; describe the change itself. Human co-authors are allowed.`);
  return errors.length === 0;
}
function checkCommits(revisions) {
  let valid = true;
  for (const sha of new Set(revisions)) {
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Invalid commit ID');
    if (!checkMessage(git('show', '-s', '--format=%B', sha, '--'), sha.slice(0, 12))) valid = false;
  }
  return valid;
}
function revisions(range) { return git('rev-list', range, '--').trim().split('\n').filter(Boolean); }

export function main(args) {
  if (args[0] === '--file' && args.length === 2) return checkMessage(readFileSync(args[1], 'utf8'), 'commit message') ? 0 : 1;
  if (args[0] === '--range' && args.length === 2) {
    const refs = args[1].split('..');
    if (refs.length !== 2 || refs.some(ref => !ref)) throw new Error('Use BASE..HEAD');
    return checkCommits(revisions(commit(refs[0]) + '..' + commit(refs[1]))) ? 0 : 1;
  }
  if (args[0] === '--all' && args.length === 1) return checkCommits(git('rev-list', '--all').trim().split('\n').filter(Boolean)) ? 0 : 1;
  if (args[0] === '--receive' && args.length === 1) {
    const commits = [];
    for (const line of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
      const [old, next, ref, extra] = line.split(/\s+/);
      if (extra || !/^[a-f0-9]{40,64}$/.test(old) || !/^[a-f0-9]{40,64}$/.test(next) || !ref?.startsWith('refs/')) throw new Error('Invalid receive input');
      if (/^0+$/.test(next)) continue; // Ref deletion.
      // Check every reachable commit, including history brought in through a new branch/tag.
      commits.push(...revisions(/^0+$/.test(old) ? commit(next) : commit(old) + '..' + commit(next)));
    }
    return checkCommits(commits) ? 0 : 1;
  }
  throw new Error('Usage: check-commit-message.mjs --file PATH | --range BASE..HEAD | --all | --receive');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { console.error('Commit policy check failed. Check Git revisions, message file and command arguments; no policy bypass was applied.'); process.exitCode = 2; }
}
