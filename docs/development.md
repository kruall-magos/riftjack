# Development and validation

Run development commands from the repository directory, unlike the instance commands used for normal operation.

[Back to Riftjack](../README.md)

## Local checks

```sh
npm run check
npm test
python3 -m unittest discover -s test -p '*_test.py'
npm audit
```

Tests use mocked backends and registration responses: routing, authorization, manager-only access changes, persistence, cancellation, replay prevention, and provisioning. A fake App Server executable verifies ChatGPT-only authentication, credential filtering, session resumption, image/file inputs and replies, active-turn steering, startup/completion races, rejected updates, child-process failure, cancellation, and denial of unsolicited approvals. Confirmation tests cover command decisions, forms and questions, parallel RPC IDs, request withdrawal, stale/replayed answers, Matrix reply quotations, sender/room/thread isolation, revocation, timeout, and fail-closed delivery. Plugin tests verify owner-only access, explicit confirmation before installation, no model turn, no automatic retry, and browser-auth links. Bridge tests also check steering order, pending limits and attachments. Media tests use real attachment encryption/decryption with a mocked Matrix transport, including tampering, byte limits, cancellation, and outbox path restrictions. Restart tests cover owner-only commands and acknowledgement failures; real child-process tests verify sequential replacement, `.env` reload, and signal forwarding. Live confirmations, plugin/OAuth flows, steering, restart acknowledgement, attachment delivery, and rendering in Element require a separate check after upgrading the running connector. The Codex adapter was developed against the 0.159.1 App Server protocol. Codex is installed and updated independently of Riftjack; mock tests do not establish compatibility with every CLI release. Check the installed CLI’s generated App Server schemas when changing the protocol adapter, and verify a real task after a CLI upgrade.

References: [Codex App Server](https://developers.openai.com/codex/app-server/), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Element Matrix bot SDK](https://github.com/element-hq/matrix-bot-sdk), [Synapse user administration](https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html), [Synapse shared-secret registration](https://element-hq.github.io/synapse/latest/admin_api/register_api.html).

## Commit policy

Install the repository-local hook after cloning:

```sh
npm run hooks:install
```

Commit messages describe the change and its purpose without AI attribution trailers or signatures. The hook and CI check this policy. See [commit policy](commit-policy.md) for its scope, checks, and server enforcement.

## Before publishing

Review the staged files and scan for credentials. Runtime data and real deployment details do not belong in this repository. See [access and encryption](security.md#keep-runtime-data-private).

## Documentation

Keep the README focused on the first successful conversation. Put command details in chat.md or manager.md, installation details in setup.md, and lifecycle behavior in operations.md. Describe current behavior and known limitations; release-specific migration notes should identify the affected version.

Built-in messages, help and documentation use English; agent conversations can use any supported language. Use neutral examples such as `projects/demo` and `@alice:example.com`, without personal conversation details or real deployment paths. Unicode names, paths and messages remain valid test inputs. Tests should check behavior and data rather than incidental wording or whitespace, except when the displayed text or layout is the behavior being tested.
