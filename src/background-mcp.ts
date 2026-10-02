import { startToolMcp } from './tool-mcp.js';
import type { BackgroundAction } from './background-tasks.js';
export const BACKGROUND_SERVER = 'riftjack_tasks';
export const BACKGROUND_TOOL = 'mcp__riftjack_tasks__background_tasks';
export const backgroundInstructions = '\nFor work that outlives this turn, use the Riftjack background_tasks MCP tool to watch a JSON status file before ending the turn. First create the file inside your workspace. Call action=watch with label, status_file, a top-level field and its terminal string values (include success and failure); optional timeout_hours is 1–168, default 24. The process must write terminal status on success and failure, preferably by atomic replacement. Riftjack persists the watch and resumes this same conversation when the bot is idle, including after connector restarts. The tool does not launch or keep processes alive. Use action=list to inspect watches or action=cancel with id to stop watching, not to kill the process. Reset or revoked access cancels pending watches. Interrupted delivery is not replayed automatically: inspect existing results before deciding what to do. Do not claim to have registered a watch until the tool confirms it.';
export function startBackgroundMcp(action: BackgroundAction, signal: AbortSignal) {
  return startToolMcp({
    name: 'background_tasks',
    description: 'Watch, list or cancel background task completion notifications in this conversation. Watches survive connector restarts. Does not execute commands or stop processes.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['watch', 'list', 'cancel'] }, id: { type: 'string' }, label: { type: 'string' },
      status_file: { type: 'string' }, field: { type: 'string' }, terminal: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
      timeout_hours: { type: 'integer', minimum: 1, maximum: 168 },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, action, signal, { server: BACKGROUND_SERVER,
    cancelled: 'Background watch request cancelled. Registration may have completed; use list before retrying.',
    failed: 'Background watch request failed. Inspect the watch list before retrying.',
  });
}
