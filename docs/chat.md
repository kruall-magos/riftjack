# Working through Matrix

Use ordinary messages for tasks and connector commands for session controls. A command is handled locally; it does not spend a model turn.

[Back to Riftjack](../README.md)

## Session controls

Send `!reset` to start a fresh conversation with that bot in the current room/thread, `!cancel` to stop a task, or `!help`. Reset removes the local conversation pointer; it does not erase Matrix history or the engine's session files.

`!help` replies locally with an English command list, without calling a model, and also works during a running task. Codex help includes confirmations, optional IDs and plugin installation; manager help includes bot creation and access-management commands. Claude help describes its queued follow-ups. Owner-only operations are marked. All three help pages use native Matrix formatting: headings, command lists, code-formatted examples and highlighted restrictions, with a readable plain-text fallback. Coding-bot help also uses quoted task examples. The same formatting is used when help accompanies a prompt-length error. No help tables are used.

Text messages beginning with `!` (after trimming whitespace and removing Matrix reply quotes) are reserved for connector commands. Unknown commands and invalid syntax, such as `!aprove` or `!reset extra`, produce a local error and help guidance; they never start a model turn, steer an active task, or enter the follow-up queue. Attachment captions and filenames remain attachment content, not commands.

Coding bots have separate sessions and use their saved workspace, or `RIFTJACK_WORKSPACE` when none was selected. Coding bots run in parallel without a shared lock; each bot still handles one task per conversation. If two bots edit the same file at the same time, one may overwrite the other's changes. Codex runs use `workspace-write` (or `read-only`) and disabled sandbox network/web search. `CODEX_APPROVAL_POLICY` defaults to `on-request`: Codex may request an exception, which is sent to Matrix for explicit approval. Set it to `never` to deny command/file/permission escalations instead. Approvals are routed to the user, not an automatic reviewer. Existing Codex configuration, managed restrictions, MCP tools, and local filesystem readability still apply; use a dedicated OS account/container if stronger isolation is needed. Connector tokens are excluded from both engines' subprocess environments.

## Messages during work

Claude queues messages from the active conversation as follow-ups; they run after the current step completes. They do not interrupt an in-flight call. See [Claude Code](claude.md#files-and-follow-up-messages).

**Codex steering:** while a Codex bot is working, send another message in the same room/thread from the same Matrix account. The connector delivers it to the active task with Codex App Server's `turn/steer`; it does not cancel or restart the task. Text, images, files, and audio attachments can all accompany an update. You receive an acknowledgement after Codex accepts it. During startup, updates wait until the active turn is ready. If the task has already finished, the message runs as the next turn in the same conversation. At most 10 updates/follow-ups can await delivery at once; each text/caption is limited to 16,000 characters. Delivery is serialized, and duplicate Matrix events are ignored.

Messages from a different account, room, thread, or bot cannot steer the current task. Independent conversations can run in parallel. `!reset` requires an idle bot; `!cancel` stops the current task and discards pending follow-ups. The task timeout covers steering and any immediate follow-ups; sending updates does not reset it. Pending updates live in memory and are not replayed after a crash/restart. If steering delivery fails with an uncertain outcome, the connector reports it rather than automatically repeating the request.

The connector uses the Codex App Server JSONL protocol over private stdio pipes, including `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, and `turn/interrupt`. Existing Codex conversation IDs remain usable. No inbound server port is opened. The App Server account must report ChatGPT authentication before a turn can start.

## Confirmations and answers

For Codex, the bot forwards command approvals, file-change approvals (with the available diff), turn-scoped permission requests, agent questions, and standard MCP form/URL requests to the active encrypted DM or thread. Each request has a random, single-use ID. When exactly one request is pending in this conversation, you can omit its ID:

```text
!approve
!deny
!answer My answer
!answer {"confirm":true}
```

If several requests are pending, specify the ID from the message. Explicit IDs also work for a single request. An unknown or expired explicit ID never selects a different request. For `!answer`, a leading 12-character hexadecimal token is interpreted as an ID; if your answer starts with such a token, include the current request ID before the answer.

In Element X, you can also tap the bot's ✅ (approve) or ❌ (decline) reaction under the last message of a confirmation. If the bot cannot add the reactions, add the same emoji manually or use a command. Reactions select that exact request even with several pending requests; only the original authorized sender in the same encrypted DM can answer. The message binding preserves thread scope. The first valid command or reaction wins; removing a reaction does not undo a decision. Expired requests and replayed reactions do nothing. Forms and questions still require `!answer`; they show only ❌. This applies to confirmations from coding bots and the manager.

Confirmation text is encrypted. The emoji and target event ID are sent as standard unencrypted Matrix annotations, without the request text or answer contents. Reactions bind only after all parts of a request have been sent successfully.

```text
!approve 012345abcdef
!deny 012345abcdef
!answer 012345abcdef My answer
!answer 012345abcdef {"confirm":true}
```

`!approve` accepts only the displayed request; it never creates a permanent allow rule or accepts a whole session. For permission requests, the displayed additional permissions last for the current turn. Questions require `!answer`; a single question takes plain text, several questions take a JSON object keyed by question ID. MCP forms take a JSON object with the requested fields and do not submit defaults automatically. The bot lists the valid commands and answer format for each request. Ordinary messages in any language are task updates, not confirmation answers. During a Codex task they are forwarded to the active agent even while a confirmation is pending. Claude queues them for the next turn. Neither path treats the text as an answer to the request. Use an explicit command or the displayed reaction to answer it.

Answers become actionable only after the complete request has been delivered. Early commands are rejected and must be sent again; they are never queued as consent. Answers are accepted only from the original authorized sender in the same bot, room and Matrix thread. Reply quotations from Matrix clients are stripped before parsing commands. Attachment captions, edited events, notices and duplicate events cannot act as answers. Access and encrypted DM membership are rechecked before delivery and acceptance. IDs expire on cancellation, task timeout, turn completion, server withdrawal, disconnect or restart; late/duplicate answers never start another model turn. The total task timeout defaults to 24 hours (`TASK_TIMEOUT_SECONDS=86400`, configurable from 1 to 86400 seconds) and includes time spent waiting for confirmation, with at most ten pending requests. Timeout and cancellation messages identify which condition stopped the task. Full request details must fit in 40,000 characters; an oversized request is declined rather than approved from a truncated preview. Missing command/diff details disable approval.

MCP URL requests provide a link to complete in a browser; approving one acknowledges the step but is not proof of authentication. Secret questions, user-verification challenges, nonstandard OpenAI forms and unknown request types are not approved. Claude tool-permission requests use a separate adapter; see [Claude Code](claude.md#permissions).

## Codex plugins

To install a plugin, the initial owner can send this to an idle Codex bot:

```text
!plugin install github
```

The connector reads the plugin description, apps and MCP servers from `openai-curated-remote`, asks for confirmation, and calls App Server's `plugin/install` only after `!approve [ID]` (ID is optional for a single pending request). This command is handled locally, without a model turn, and also works with existing conversations. Installation affects the shared Codex account/host. The service still enforces account and installation policies. If browser login is required, the bot returns the service's login links; passwords and tokens should not be sent to Matrix. An uncertain installation result is not automatically retried. This is separate from desktop-only `request_plugin_install` UI prompts, which cannot be completed by sending “confirm” as ordinary chat text.

## Delivery and formatting

Messages sent before the current startup are ignored, including messages sent while the connector was offline. Duplicate events are recorded before work begins to reduce accidental re-execution. An interrupted task is not automatically replayed after restart. Tasks time out after 24 hours by default. Replies are chunked, with a 100,000-character cap.

Coding bots render Markdown replies as sanitized Matrix HTML (`format: org.matrix.custom.html` and `formatted_body`), with a readable plain-text fallback. Element X can display emphasis, links, lists and code blocks without showing Markdown delimiters. Tables use monospace blocks. Long replies retain balanced formatting across chunks. Raw HTML is displayed literally, and Markdown images become links; file delivery still uses encrypted attachments. Manager replies also use native formatting: bot lists have bold names and code-formatted IDs and folders; help has headings and commands; profile and access updates highlight their outcome. User-supplied names and paths remain literal. Confirmations use headings, highlighted field labels and literal code blocks for commands, paths and changes, with the same readable plain-text fallback. Their short footer lists reactions and commands; IDs are optional when exactly one request is pending. Long confirmation details are split without truncation, and both commands and reactions become actionable only after the entire request is delivered. Operational errors and coding-bot command responses stay plain text.

## Account usage

The initial owner can send `!usage` to a Claude bot to see the Claude account's current session and weekly limits and their reset times. It runs Claude Code's local `/usage` command, which makes no model request, and works while a task is running.
The initial owner can also send `!usage` to a Codex bot, even during a task, to read the shared ChatGPT account's weekly limit via Codex App Server (`account/rateLimits/read`), without a model request. Both engines use the same table format: **Time** is time until reset, **Quota** is the remaining percentage, **Target** is the remaining quota per hour/day until reset, and **Pace ratio** compares that pace with an even 100% over the whole period. Codex also shows the next weekly reset date with the connector’s time zone and the available additional reset count reported by the service. Reading `!usage` does not spend a reset. Missing data is shown as unavailable, not as unused quota.

## Images, files, and audio

Coding bots accept encrypted Matrix image, file, and audio attachments, including voice recordings sent as `m.audio`. Attach a file normally in Element, optionally with a caption. PNG, JPEG, GIF, and WebP images are supplied as native image inputs. Documents and audio are saved locally and their paths are supplied to the selected engine. There is no automatic speech transcription or speech synthesis; sending an audio file does not by itself mean the agent can listen to it. The manager accepts text commands and encrypted images with an authorized `set avatar Riftjack Codex` caption; other attachments are rejected.

Ask a coding bot naturally to send an image, document, or audio file, for example “Send me the report as a PDF” or “Send the WAV file you created.” Each turn provides the agent with a separate outbox and instructions for explicitly attaching its results. The connector sends pictures as `m.image`, supported audio formats (MP3, WAV, OGG/Opus, M4A, AAC, FLAC, WEBA) as `m.audio`, and other formats as `m.file`. SVG is delivered as a file. Ordinary Markdown links and paths in a response do not upload files.

File contents are encrypted before upload. The filename, MIME type, size, and decryption key are delivered inside the encrypted room message. Incoming attachments must also use file encryption and pass integrity verification. Attachments preserve replies and Matrix threads. Access and room membership are checked again before delivery; cancellation stops pending downloads and prevents delivery after an upload completes.

The default limit is **20 MiB per attachment**, configurable with `MAX_MEDIA_BYTES` up to 100 MiB. A reply can contain at most 10 files. The homeserver may impose a smaller upload limit. Downloads are bounded by actual bytes, even if the sender omits or understates the size. Attachments sent to the active conversation are downloaded in order and delivered as steering updates, or processed in a follow-up turn if the current task just finished.

Files are kept under each bot’s workspace in `.matrix-media/`, in separate incoming and outgoing directories, with private filesystem permissions. Outgoing files must be regular files inside the current turn's outbox; symlinks, hard links, and paths outside it are rejected. Files remain available for follow-up questions and are not deleted by `!reset`. Remove old media manually when it is no longer needed. Bots assigned the same workspace share its filesystem; media directories are not an isolation boundary between allowed users. Add `.matrix-media/` to each selected repository’s ignore rules. A read-only Codex sandbox can inspect incoming attachments but cannot create new outbox files.
