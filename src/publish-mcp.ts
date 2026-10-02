import { startToolMcp } from './tool-mcp.js';
import { publishInput } from './publish.js';

export type PublishAction = (input: unknown, signal: AbortSignal) => Promise<string>;
export type PublishConnection = { url: string; headers: { Authorization: string } };
export const PUBLISH_SERVER = 'riftjack_publish';
export const PUBLISH_TOOL = 'mcp__riftjack_publish__prepare_publish';
export const publicationInstructions = '\nFor Git publication, call the Riftjack prepare_publish MCP tool with repository, remote and branch. Commit intended changes first. The tool sends a complete HTML review to this Matrix conversation, waits for explicit human approval, and only then pushes the reviewed commits. Do not substitute a shell push or treat ordinary chat as approval. A declined, cancelled or uncertain publication must not be retried automatically.';

const tool = {
  name: 'prepare_publish',
  description: 'Prepare and deliver an HTML review of committed Git changes to the current Matrix conversation, wait for human approval, then publish exactly those commits. This call may wait for up to the task timeout. Never retry automatically after cancellation or an uncertain result.',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { repository: { type: 'string', description: 'Git repository path within the bot workspace.' }, remote: { type: 'string', description: 'Named Git remote, for example origin.' }, branch: { type: 'string', description: 'Destination branch, for example main.' } },
    required: ['repository', 'remote', 'branch'] },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};
export function startPublishMcp(publish: PublishAction, signal: AbortSignal) {
  return startToolMcp(tool, (input, callSignal) => publish(publishInput(input), callSignal), signal, {
    server: 'riftjack-publish',
    cancelled: 'Publication cancelled. Do not retry automatically; a push already in progress may have completed.',
    failed: 'Publication failed. Check the destination before attempting another reviewed request.',
  });
}
