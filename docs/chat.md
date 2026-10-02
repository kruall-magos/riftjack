# Working through Matrix

Use ordinary messages for tasks and connector commands for session controls. A command is handled locally; it does not spend a model turn.

Agent responses use ordinary Matrix text messages (`m.text`). Connector status, errors, help and confirmations use notices (`m.notice`), which some clients mark with an information icon. Bot messages appear without quoting the message that triggered them. Messages, confirmations and attachments sent within a Matrix thread stay in that thread.

[Back to Riftjack](../README.md)

## Session controls

Send `!reset` to start a fresh conversation with that bot in the current room/thread, `!cancel` to stop a task, or `!help`. Reset removes the local conversation pointer; it does not erase Matrix history or the engine's session files.

`!help` replies locally with an English command list, without calling a model, and also works during a running task. Codex help includes confirmations, optional IDs and plugin installation; manager help includes bot creation and access-management commands. Claude help describes its queued follow-ups. Owner-only operations are marked. All three help pages use native Matrix formatting: headings, command lists, code-formatted examples and highlighted restrictions, with a readable plain-text fallback. Coding-bot help also uses quoted task examples. The same formatting is used when help accompanies a prompt-length error. No help tables are used.

Text messages beginning with `!` (after trimming whitespace and removing Matrix reply quotes) are reserved for connector commands. Unknown commands and invalid syntax, such as `!aprove` or `!reset extra`, produce a local error and help guidance; they never start a model turn, steer an active task, or enter the follow-up queue. Attachment captions and filenames remain attachment content, not commands.

Coding bots have separate sessions and use their saved workspace, or `RIFTJACK_WORKSPACE` when none was selected. Coding bots run in parallel without a shared lock; each bot still handles one task per conversation. If two bots edit the same file at the same time, one may overwrite the other's changes. Codex runs use `workspace-write` (or `read-only`) and disabled sandbox network/web search. `CODEX_APPROVAL_POLICY` defaults to `on-request`: Codex may request an exception, which is sent to Matrix for explicit approval. Set it to `never` to deny command/file/permission escalations instead. Approvals are routed to the user, not an automatic reviewer. Existing Codex configuration, managed restrictions, MCP tools, and local filesystem readability still apply; use a dedicated OS account/container if stronger isolation is needed. Connector tokens are excluded from both engines' subprocess environments.

## Reactions

React to an agent's ordinary text message with 👍 for agreement, 👎 for negative feedback, or ❤️ for strong appreciation or support. Reactions are interpreted in the context of the message and ongoing agreements. On a concrete proposed next step within the agreed work, either 👍 or ❤️ can mean “yes, go ahead”: the agent is instructed to continue that work. A reaction to a completed result or a personal remark may simply express appreciation; it does not require inventing a new task. Thumb skin tones and text/emoji heart variants are supported. Riftjack passes the reaction and an excerpt of the original message to the agent immediately, in that message's conversation and thread. An idle Codex or Claude starts a turn; a busy agent uses the normal steering or follow-up path. Grok receives the feedback through its durable worker queue. There is no separate acknowledgement message for feedback.

Only reactions from an authorized conversation partner to that bot's text messages are forwarded. Reactions to notices, confirmations, other people's messages and unsupported emoji are ignored. The normal busy/publication rules still apply. Repeated delivery of the same reaction event is deduplicated. Removing a reaction does not retract feedback already delivered to the agent. Conversational agreement does not answer a pending confirmation request or replace a required approval, including publication approval; confirmation controls remain ✅ and ❌ on the specific pending request.

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

Coding bots render Markdown replies as sanitized Matrix HTML (`format: org.matrix.custom.html` and `formatted_body`), with a readable plain-text fallback. Element X can display emphasis, links, lists and code blocks without showing Markdown delimiters. Tables use monospace blocks. Long replies retain balanced formatting across chunks. Raw HTML is displayed literally, and Markdown images become links; file delivery still uses encrypted attachments. Manager replies also use native formatting: bot lists have bold names and code-formatted IDs and folders; help has headings and commands; profile and access updates highlight their outcome. User-supplied names and paths remain literal. Confirmations use headings, highlighted field labels and literal code blocks for commands, paths and changes, with the same readable plain-text fallback. Their short footer lists reactions and commands; IDs are optional when exactly one request is pending. Long confirmation details are split without truncation, and both commands and reactions become actionable only after the entire request is delivered. Operational errors and most coding-bot command responses stay plain text; help, status and usage use formatted replies.

## Bot status

Send `!status` to a Codex or Claude Code bot to see its task state and configured workspace/model. Codex also shows configured reasoning effort and service tier. The command works during a task, does not steer or queue a prompt, and does not start a CLI process or make a model request. It is available to accounts authorized to use the bot in a private conversation.

The separate **Last CLI session report** section shows metadata reported when Codex starts/resumes a thread or Claude Code emits its session initialization event, with the report timestamp. Codex reports its model, reasoning effort, service tier and workspace. Claude reports its model, workspace, permission mode and Fast mode when available. Claude's ordinary stream output may omit effort; missing fields are shown as unknown. These are session reports, not per-request inference receipts or live queries. Changed settings, model fallback or changes made outside Riftjack may differ from the last report.

Reports are scoped to the bot, sender, room and Matrix thread, survive connector restarts, and are cleared by `!reset`. A new conversation has no report until its CLI starts a task. No other conversation's report or task details are shown. Grok's `!status` shows queue/lease/delivery counts; its model settings and workspace are controlled by the external worker and are not reported to Riftjack.

## Reviewed publication

Codex and Claude Code can request publication themselves through the `prepare_publish` MCP tool. Ask the bot to publish committed changes; it supplies `repository`, `remote` and `branch`. Riftjack sends the HTML review to the current conversation, then asks for confirmation. The tool waits for your decision and returns the publication result to the agent. There is no keyword in the agent's reply that triggers a push.

The tool is available to every authorized user of a writable Codex or Claude bot, including users granted access only to that bot. Only the user who requested the publication can confirm it, in the same conversation. Its local connection is created for each task and closed when that task ends. The tool timeout follows `TASK_TIMEOUT_SECONDS` (24 hours by default). The connector checks access and room privacy again before pushing; it does not expose an approval API to agents. Global Codex and Claude MCP settings are not edited. Starting `prepare_publish` is allowed without a preliminary tool-consent prompt; publication still requires the separate Matrix confirmation after report delivery. This exception is limited to that one connector tool. Other configured MCP servers retain their existing policies.

Any authorized user can ask an idle Codex or Claude Code bot to review and publish committed changes:

```text
!publish {"repository":".","remote":"origin","branch":"main"}
```

The repository path is relative to that bot's workspace (an absolute path inside it also works). Supply a configured remote name and the destination branch explicitly. Access to a writable bot includes reviewed publication of repositories inside its workspace using the host’s Git credentials. There is no separate per-user repository or remote allowlist; users sharing a bot share this scope. The connector performs this structured command locally; it does not ask a model to interpret it. Read-only bots and external Grok workers cannot publish through this command.

Riftjack resolves the push destination, reads its branch tip and prepares a self-contained HTML attachment. It contains the final diff and **every outgoing commit**, including changes later reverted. File sections collapse, added/deleted lines have colors and line numbers, and the file needs no JavaScript or external resources. Binary contents are marked as unavailable for text review. Uncommitted files, other local branches and unrelated tags are excluded. Git authentication must already work on the host; the connector does not collect credentials.

After the attachment and confirmation text have been delivered, approve with the usual reaction or `!approve ID`, or decline with `!deny ID`. Delivery does not prove the report was opened. Approval applies to the shown commit, destination branch and expected remote tip only. Changed HEAD or destination invalidates the review. An explicit Git lease also prevents a concurrent remote update from being overwritten. Only fast-forward updates and new branches from complete (non-shallow) repositories are supported. There is no automatic retry after an uncertain push result.

`!cancel`, access revocation and task timeout stop a pending review. Approval is conversation-scoped and expires on restart. Reports are deleted from the host after the request ends; the encrypted attachment remains in Matrix. `!status` remains available while reviewing, but ordinary chat messages cannot steer the publication into a different action. Reports over 100 outgoing commits or 8 MiB of diff text are refused rather than truncated. The normal attachment size limit also applies.

A report-only CLI is available to agents and local tools:

```sh
node --import tsx scripts/prepare-publish.mts --workspace /path/to/workspace \
  --request '{"repository":"project","remote":"origin","branch":"main"}' \
  --output /path/to/review.html
```

It returns JSON identifying the report, commits and SHA-256, never pushes, and refuses to overwrite an existing output file. It reads the remote and may fetch its base commit into the local object store without changing working files or branches. The TypeScript API is `preparePublish`; the Matrix handler adds delivery, explicit confirmation and publication. External-worker publication endpoints are not implemented. Ordinary shell `git push` approvals do not gain an HTML review automatically. Git hooks and host Git configuration remain trusted host code; this workflow is not an OS security boundary against other processes running under the same account.

## Account usage

The initial owner can send `!usage` to a Claude bot to see the Claude account's current session and weekly limits and their reset times. It runs Claude Code's local `/usage` command, which makes no model request, and works while a task is running.
The initial owner can also send `!usage` to a Codex bot, even during a task, to read the shared ChatGPT account's weekly limit via Codex App Server (`account/rateLimits/read`), without a model request. Both engines use the same table format: **Time** is time until reset, **Quota** is the remaining percentage, **Target** is the remaining quota per hour/day until reset, and **Pace ratio** compares that pace with an even 100% over the whole period. Codex also shows the next weekly reset date with the connector’s time zone and the available additional reset count reported by the service. Reading `!usage` does not spend a reset. Missing data is shown as unavailable, not as unused quota.

## Images, files, and audio

Coding bots accept encrypted Matrix image, file, and audio attachments, including voice recordings sent as `m.audio`. Attach a file normally in Element, optionally with a caption. PNG, JPEG, GIF, and WebP images are supplied as native image inputs. Documents and audio are saved locally and their paths are supplied to the selected engine. There is no automatic speech transcription or speech synthesis; sending an audio file does not by itself mean the agent can listen to it. The manager accepts text commands and encrypted images with an authorized `set avatar Riftjack Codex` caption; other attachments are rejected.

Ask a coding bot naturally to send an image, document, or audio file, for example “Send me the report as a PDF” or “Send the WAV file you created.” Each turn provides the agent with a separate outbox and instructions for explicitly attaching its results. The connector sends pictures as `m.image`, supported audio formats (MP3, WAV, OGG/Opus, M4A, AAC, FLAC, WEBA) as `m.audio`, and other formats as `m.file`. SVG is delivered as a file. Ordinary Markdown links and paths in a response do not upload files.

File contents are encrypted before upload. The filename, MIME type, size, and decryption key are delivered inside the encrypted room message. Incoming attachments must also use file encryption and pass integrity verification. Attachments preserve Matrix threads without quoting the incoming message. Access and room membership are checked again before delivery; cancellation stops pending downloads and prevents delivery after an upload completes.

The default and maximum limit is **512 MiB per attachment** (536,870,912 bytes). Set `MAX_MEDIA_BYTES` to a smaller value if needed. A reply can contain at most 10 files. The homeserver may impose a smaller upload limit. Downloads are bounded by actual bytes, even if the sender omits or understates the size. Attachments sent to the active conversation are downloaded in order and delivered as steering updates, or processed in a follow-up turn if the current task just finished.

Outgoing attachments are read and encrypted in bounded chunks while uploading. `MEDIA_UPLOAD_TIMEOUT_SECONDS` sets the overall upload deadline (default: 1800 seconds, range: 1–86400). Cancellation stops the upload; failed uploads are not retried automatically. The supervisor log records `media-upload` start, completion, or failure with a transfer ID, file size, ciphertext bytes read, and elapsed milliseconds. The duration covers reading, encryption, upload, and the server response, not the recipient's download. HTTP status codes and safe network error codes are reported without filenames, access tokens, encryption keys, or server response bodies. Incoming downloads and the external worker's JSON/base64 interface still buffer data in memory.

Files are kept under each bot’s workspace in `.matrix-media/`, in separate incoming and outgoing directories, with private filesystem permissions. Outgoing files must be regular files inside the current turn's outbox; symlinks, hard links, and paths outside it are rejected. Files remain available for follow-up questions and are not deleted by `!reset`. Remove old media manually when it is no longer needed. Bots assigned the same workspace share its filesystem; media directories are not an isolation boundary between allowed users. Add `.matrix-media/` to each selected repository’s ignore rules. A read-only Codex sandbox can inspect incoming attachments but cannot create new outbox files.
