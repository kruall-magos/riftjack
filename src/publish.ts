import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PublicError } from './errors.js';
import { renderPublishReview } from './publish-html.js';
import { confirmationDetails } from './confirmation-format.js';
import type { Interact } from './interactions.js';

const exec = promisify(execFile);
const LIMIT = 8 * 1024 * 1024;
export type PublishInput = { repository: string; remote: string; branch: string };
export type PublishReview = Readonly<PublishInput & {
  url: string; base: string | null; head: string; createdAt: string;
  commits: readonly string[]; patch: string; history: readonly { oid: string; patch: string }[];
  workingTreeDirty: boolean; html: string; sha256: string;
}>;

export function publishInput(value: unknown): PublishInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PublicError('Supply repository, remote and branch.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['repository', 'remote', 'branch'].includes(k)) ||
      typeof v.repository !== 'string' || !v.repository || v.repository.length > 4096 || /[\x00-\x1f]/.test(v.repository) ||
      typeof v.remote !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v.remote) ||
      typeof v.branch !== 'string' || !v.branch || v.branch.length > 255 || v.branch.startsWith('-')) {
    throw new PublicError('Supply only repository (a directory), remote (a configured name) and branch (a branch name).');
  }
  return { repository: v.repository, remote: v.remote, branch: v.branch };
}

async function git(repo: string, args: string[], signal: AbortSignal, input?: string): Promise<string> {
  signal.throwIfAborted();
  try {
    // Never interpret a shell command or inherit Git routing from the calling process.
    const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SSH_AUTH_SOCK'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => allowed.includes(k)));
    const operation = exec('git', ['--no-pager', '-c', 'core.quotePath=true', ...args], {
      cwd: repo, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }, signal,
      timeout: 120_000, maxBuffer: LIMIT, encoding: 'utf8',
    });
    operation.child.stdin?.end(input);
    const { stdout } = await operation;
    return stdout;
  } catch {
    signal.throwIfAborted();
    throw new PublicError('Git review operation failed or exceeded its size/time limit. Check repository access and Git authentication on the host.');
  }
}

async function destination(repo: string, remote: string, signal: AbortSignal) {
  const urls = (await git(repo, ['remote', 'get-url', '--push', '--all', remote], signal)).trim().split('\n');
  if (urls.length !== 1 || !urls[0]) throw new PublicError('Publication requires exactly one push URL.');
  const url = urls[0];
  // Reject executable remote helpers and credentials embedded in HTTP URLs.
  if (/^https:\/\//.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new PublicError('Use a credential-free HTTPS remote URL and host Git authentication.');
  } else if (!(/^ssh:\/\//.test(url) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(url) || isAbsolute(url))) {
    throw new PublicError('Use an HTTPS, SSH, or absolute local-path remote.');
  }
  if (url.startsWith('ssh://') && new URL(url).password) throw new PublicError('Use SSH keys without a password embedded in the URL.');
  if (/[\x00-\x1f\x7f]/.test(url) || (!isAbsolute(url) && /\s/.test(url))) throw new PublicError('Invalid remote URL.');
  return url;
}

async function remoteHead(repo: string, url: string, ref: string, signal: AbortSignal): Promise<string | null> {
  const output = (await git(repo, ['ls-remote', '--refs', '--', url, ref], signal)).trim();
  if (!output) return null;
  const lines = output.split('\n');
  const [oid, name] = lines[0].split('\t');
  if (lines.length !== 1 || name !== ref || !/^[a-f0-9]{40,64}$/.test(oid)) throw new PublicError('Unexpected remote branch response.');
  return oid;
}

export async function preparePublish(input: PublishInput, workspace: string, signal: AbortSignal): Promise<PublishReview> {
  input = publishInput(input);
  const root = await realpath(workspace), repository = await realpath(resolve(root, input.repository));
  const rel = relative(root, repository);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new PublicError('Repository must be inside this bot’s workspace.');
  if ((await realpath((await git(repository, ['rev-parse', '--show-toplevel'], signal)).trim())) !== repository) throw new PublicError('Choose the repository root directory.');
  if ((await git(repository, ['rev-parse', '--is-shallow-repository'], signal)).trim() !== 'false') throw new PublicError('A complete repository history is required; shallow repositories cannot be reviewed.');
  await git(repository, ['check-ref-format', 'refs/heads/' + input.branch], signal);
  const url = await destination(repository, input.remote, signal);
  const head = (await git(repository, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
  const base = await remoteHead(repository, url, 'refs/heads/' + input.branch, signal);
  if (base === head) throw new PublicError('The destination already contains this HEAD; there is nothing to publish.');
  if (base) {
    await git(repository, ['fetch', '--no-tags', '--no-write-fetch-head', '--', url, base], signal);
    try { await git(repository, ['merge-base', '--is-ancestor', base, head], signal); }
    catch { throw new PublicError('The destination is not an ancestor of HEAD. Reconcile the branches before requesting publication; history replacement is not supported.'); }
  }
  const commits = (await git(repository, ['rev-list', '--reverse', base ? base + '..' + head : head], signal)).trim().split('\n');
  if (commits.length > 100) throw new PublicError('Review exceeds 100 outgoing commits. Prepare a smaller publication.');
  const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--ignore-submodules=none'];
  const emptyTree = base ? undefined : (await git(repository, ['hash-object', '-w', '-t', 'tree', '--stdin'], signal, '')).trim();
  const patch = base ? await git(repository, ['diff', ...diffOptions, base, head, '--'], signal)
    : await git(repository, ['diff', ...diffOptions, emptyTree!, head, '--'], signal);
  const history: { oid: string; patch: string }[] = [];
  let size = Buffer.byteLength(patch);
  for (const oid of commits) {
    const content = await git(repository, ['show', '--format=fuller', '--root', '--diff-merges=first-parent', ...diffOptions, oid, '--'], signal);
    size += Buffer.byteLength(content);
    if (size > LIMIT) throw new PublicError('Complete review exceeds 8 MiB of text. No truncated review will be approved.');
    history.push(Object.freeze({ oid, patch: content }));
  }
  const workingTreeDirty = !!(await git(repository, ['status', '--porcelain', '--untracked-files=normal'], signal)).trim();
  const data = { ...input, repository, url, base, head, createdAt: new Date().toISOString(), commits: Object.freeze(commits), patch,
    history: Object.freeze(history), workingTreeDirty };
  const html = renderPublishReview(data);
  return Object.freeze({ ...data, html, sha256: createHash('sha256').update(html).digest('hex') });
}

export async function pushReviewed(review: PublishReview, signal: AbortSignal, authorize: () => Promise<void> = async () => {}): Promise<void> {
  if ((await git(review.repository, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim() !== review.head ||
      await destination(review.repository, review.remote, signal) !== review.url ||
      await remoteHead(review.repository, review.url, 'refs/heads/' + review.branch, signal) !== review.base) {
    throw new PublicError('HEAD or the destination changed after review. Prepare a new report and request confirmation again.');
  }
  await authorize();
  signal.throwIfAborted();
  try {
    await git(review.repository, ['-c', 'push.followTags=false', 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no',
      '--force-with-lease=refs/heads/' + review.branch + ':' + (review.base ?? ''), '--', review.url, review.head + ':refs/heads/' + review.branch], signal);
  } catch {
    throw new PublicError('Publication was not confirmed. It may have reached the remote; check the destination before retrying. Nothing was retried automatically.');
  }
}

export async function requestPublish(input: unknown, workspace: string, reportRoot: string, maxBytes: number, signal: AbortSignal, interact: Interact, authorize: () => Promise<void>): Promise<string> {
  const review = await preparePublish(publishInput(input), workspace, signal);
  if (Buffer.byteLength(review.html) > maxBytes) throw new PublicError('Complete HTML review exceeds the attachment limit.');
  const directory = await mkdtemp(join(reportRoot, 'publish-review-'));
  try {
    const name = 'publish-' + review.head.slice(0, 12) + '.html', path = join(directory, name);
    await writeFile(path, review.html, { flag: 'wx', mode: 0o600 });
    const decision = await interact({ ...confirmationDetails([
      { value: 'Publish the commits in the attached HTML review?' },
      { label: 'Repository', value: review.repository, code: true }, { label: 'Destination', value: review.url + ' → ' + review.branch, code: true },
      { label: 'Remote base', value: review.base ?? '[new branch]', code: true }, { label: 'Publish HEAD', value: review.head, code: true },
      { label: 'Outgoing commits', value: String(review.commits.length) }, { label: 'Report SHA-256', value: review.sha256, code: true },
      { value: 'Only this commit and its history are published. Local uncommitted files and unrelated tags are excluded. Changed HEAD or destination requires a new review.' },
    ]), attachments: [{ path, root: directory, name }], approve: { publish: true }, deny: { publish: false } }, signal);
    signal.throwIfAborted();
    if (!('publish' in decision) || decision.publish !== true) return 'Publication declined. No push was made.';
    await pushReviewed(review, signal, authorize);
    return `Published ${review.head} to ${review.remote}/${review.branch}.`;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
