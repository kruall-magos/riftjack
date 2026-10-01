type StateEvent = { type?: string; state_key?: string; content?: Record<string, unknown> };

// Inspect one current state response, including invitations, not just joined members.
export function isPrivateRoomState(state: StateEvent[], bot: string, sender: string): boolean {
  const content = (type: string) => state.find(e => e.type === type && e.state_key === '')?.content;
  if (bot === sender || content('m.room.encryption')?.algorithm !== 'm.megolm.v1.aes-sha2' ||
    content('m.room.join_rules')?.join_rule !== 'invite' ||
    content('m.room.history_visibility')?.history_visibility !== 'joined') return false;
  const members = state.filter(e => e.type === 'm.room.member');
  if (members.some(e => ['join', 'invite', 'knock'].includes(String(e.content?.membership)) &&
    e.state_key !== bot && e.state_key !== sender)) return false;
  return [bot, sender].every(id => members.find(e => e.state_key === id)?.content?.membership === 'join');
}

export async function isPrivateRoom(client: { getRoomState: (room: string) => Promise<StateEvent[]> }, room: string,
  bot: string, sender: string, authorized: (sender: string) => boolean): Promise<boolean> {
  if (!authorized(sender)) return false;
  const state = await client.getRoomState(room);
  return authorized(sender) && isPrivateRoomState(state, bot, sender);
}
