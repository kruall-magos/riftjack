# One agent across private and shared rooms

A linked agent continues one existing Codex or Claude session from its private
chat and an explicitly allowed shared room. No history is copied into a new
session. Each agent keeps its own session and processes one task at a time;
different agents can work concurrently.

This is opt-in. Ordinary bots retain their separate DM/thread conversations.
Grok workers and the manager do not support session links.

## Configuration

Start each agent in its own encrypted DM and establish the session to keep.
While the connector is stopped, create `DATA_DIR/conversation-links.json` using
the existing Matrix IDs, original DM room IDs, and session IDs from
`DATA_DIR/sessions.json`. Its session keys encode `[room, sender, thread-or-null]`.
Set the optional agent `thread` field if the original session began inside a
Matrix thread. Never guess a session ID or replace it with another agent's ID.

```json
{
  "version": 1,
  "agents": [
    {"bot":"@builder:example.com", "owner":"@alice:example.com", "home":"!builder-dm:example.com", "session":"existing-builder-session"},
    {"bot":"@reviewer:example.com", "owner":"@alice:example.com", "home":"!reviewer-dm:example.com", "session":"existing-reviewer-session"}
  ],
  "rooms": [
    {"room":"!project:example.com", "owner":"@alice:example.com", "bots":["@builder:example.com", "@reviewer:example.com"]}
  ]
}
```

Create the shared Matrix room with encryption, invite-only access and history
visibility **joined**, then invite the owner and the two bots. Restart the
connector. Shared-room processing requires all three participants to have joined
and no extra joined, invited or knocking participant.

The initial connector owner controls these links. Every local participant must
have a link to a distinct existing session. A missing or different session causes
an error instead of a fresh start. `!reset` is disabled for linked agents;
replacing a session requires an explicit configuration change. Linking grants
no access to another agent's workspace or private conversation.

For agents in separate installations, put only the local agent in each
installation's `agents` array, with the same owner and group in `rooms`. Both
installations need this feature and retain their own agent's session. Do not run
the same agent session in two connectors.

## Messages and turns

- A Matrix **@mention** addresses one agent. An unaddressed human message in the
  shared room addresses both. Plain text spelling a display name is not a mention.
- Another room never steers a running task. Its messages enter a persistent queue
  and run in their own room later. Same-room updates retain existing steering.
  Threads remain separate delivery and approval scopes even with a linked session.
- Adjacent queued human messages in the same room/thread are combined in order,
  up to the prompt budget. Overflow and messages from the next room stay queued.
  Attachments remain attached to their batch.
- Shared messages are recorded as observations, with independent read positions
  for each local agent. Before a new turn, unread text and attachment metadata are
  delivered in order. Oversized messages are explicitly split, retaining the rest
  on disk. Read positions advance only after a successful model turn; failed
  turns may receive the same observations again.
- Observations never enter cross-room steering and contain no private DM
  transcript. A new private turn can receive unread shared observations; a shared
  turn receives observations only from its own room.
- Agent messages are context, not human instructions or approvals. An ordinary
  agent message, a display name or a `matrix.to` link does not start a turn.
- Replies, progress, attachments and permissions stay in the initiating room and
  thread. Only the initiating human can answer a confirmation there. Sharing a
  session does not allow approval from another room or another bot.
- `!status` shows the linked session and queued-message count. `!cancel` cancels
  the current conversation's task and queued messages, not another room's work.
  The queue accepts 20 messages and explicitly reports overflow.

Queued messages survive restart and access is checked again before execution.
An active batch is not replayed after interruption: its actions may already have
happened. The observation log starts when configured events arrive; it does not
backfill old Matrix history or recover events missed while offline.


## Peer mentions

An agent can ask the other agent in the shared room to respond. It appends one
block to its final reply:

````text
```matrix-mentions
{"to":["@reviewer:example.com"]}
```
````

The connector removes the block, checks that each recipient is the other agent
of this room, and sends the reply with `m.mentions` and a visible pill on its
last part, after any attachments. An invalid block sends no mention; the room
gets a notice and the agent receives the error with its next turn.

A received mention starts a separate turn for the mentioned agent:

- It runs after the agent's current task and never steers it. Mentions are not
  merged with queued human messages.
- The prompt marks the turn as started by the peer. The peer's message arrives
  only as a quoted observation; the turn itself is a connector notice in the
  human's approval scope, so confirmations still go to the human. Matrix events
  cannot claim to be such a notice.
- The agent may answer `NO_REPLY`; nothing is sent then.
- Each agent can be started this way at most twice per human message. The
  count is saved before the turn is admitted and includes silent or failed
  turns. Agent replies carry the human message they belong to, so a late reply to
  an earlier task spends that task's budget, not the current one.
- Confirmation requests are marked as service messages: they are neither
  observations nor triggers.

## Privacy

Room membership and privacy settings are rechecked before processing and outgoing
delivery. Peer bots are never added to human access lists.

The same model session knows both private and shared conversations. Routing
instructions tell it where it is replying, but this is **not strict information
isolation**: it could still mention private information in a shared answer.
Use separate sessions when strict context separation is required.

Back up `sessions.json`, `conversation-links.json` and `shared-room-history.json`.
The latter stores shared observations and read positions with private filesystem
permissions. A changed group does not reuse another membership's observation log.

[Chat commands](chat.md) · [Back to Riftjack](../README.md)
