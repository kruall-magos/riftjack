import { startToolMcp, type ToolAction } from './tool-mcp.js';

export const ROOM_MESSAGE_SERVER = 'riftjack_rooms';
export const ROOM_MESSAGE_TOOL = 'mcp__riftjack_rooms__room_messages';
export const roomMessageInstructions = '\nUse the Riftjack room_messages MCP tool to send text to an explicitly linked shared room when the human has authorized sharing it there. action=list returns allowed rooms. action=send requires room, text and a unique id for this message. Text is sent literally, without Markdown processing. Set mention=true to also start the other agent of that room; it costs one of your peer credits, which a new human message to you restores, and is refused when none is left. Keep private conversation details private unless explicitly authorized to share them. The normal reply still goes only to the current conversation. Wait for the delivery result before claiming success. Reusing the same id and content during this turn returns the previous result without resending. After a failed or uncertain send, never retry with a new id or in a new turn automatically.';

export function startRoomMessageMcp(action: ToolAction, signal: AbortSignal) {
  return startToolMcp({
    name: 'room_messages',
    description: 'List explicitly linked shared rooms or send text there as the current bot. Requires human authorization to share the text. Returns the sent event ID. Repeated message ids are not resent during this turn, including after failures. Never automatically retry an uncertain send with another id.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['list', 'send'] }, room: { type: 'string' },
      text: { type: 'string', description: 'Literal text, at most 8000 UTF-8 bytes, or 6000 with mention.' },
      id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' },
      mention: { type: 'boolean', description: 'Also start the other agent of the room, paid with one peer credit.' },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, action, signal, { server: ROOM_MESSAGE_SERVER,
    cancelled: 'Room message request cancelled. Delivery may have completed. Inspect the destination before any new attempt.',
    failed: 'Room message request failed. Delivery is uncertain. Inspect the destination before any new attempt.',
  });
}
