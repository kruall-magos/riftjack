# Development and validation

Run development commands from the repository directory, unlike the instance commands used for normal operation.

[Back to Riftjack](../README.md)

## Local checks

```sh
npm run check
npm test
python3 -m unittest discover -s test -p '*_test.py'
```

`npm test` runs the tests in `test/` without opening HTTP listening ports. They use local files, child-process stubs and mocked transports; run them in the normal sandbox without requesting network or port access.

`npm run test:http` runs `test/http/*.test.ts`. These tests bind an ephemeral port on `127.0.0.1` and make loopback requests, including from the Python worker client. They use no live Matrix service or model account. A sandbox that blocks listening ports may require permission for this command.

Run the HTTP suite when changing the publication, background-task, attachment or room-message MCP transport or its Codex/Claude integration, the worker HTTP server, API authentication/routing, long polling, request/response or attachment handling, `scripts/worker-client.py`, or queue/service behavior exposed through that API. Also run it when changing its fixtures, suite layout, or relevant dependencies. Changes confined to chat commands, formatting, documentation, or Codex/Claude adapters normally need only the relevant ordinary tests and type checking. Queue and worker-status unit tests remain in `npm test`. Publication logic tests use temporary local bare Git repositories and need no listening port or live GitHub access. MCP integration tests in `test/http/` open loopback ports and use CLI doubles plus local bare repositories; they make no model requests or live GitHub calls.

Use `npm run test:all` when a full validation is intended; it runs both suites and requires permission to open a loopback port in restricted environments. Put future port-opening tests under `test/http/`; keep tests that need no listener in `test/`. Type checking includes both directories. Run `npm audit` separately when checking dependencies; it contacts the package registry.

Tests use mocked backends and registration responses: routing, authorization, manager-only access changes, persistence, cancellation, replay prevention, and provisioning. A fake App Server executable verifies ChatGPT-only authentication, credential filtering, session resumption, image/file inputs and replies, active-turn steering, startup/completion races, rejected updates, child-process failure, cancellation, and denial of unsolicited approvals. Confirmation tests cover command decisions, forms and questions, parallel RPC IDs, request withdrawal, stale/replayed answers, Matrix reply quotations, sender/room/thread isolation, revocation, timeout, and fail-closed delivery. Plugin tests verify owner-only access, explicit confirmation before installation, no model turn, no automatic retry, and browser-auth links. Bridge tests also check steering order, pending limits and attachments. Media tests use real attachment encryption/decryption with a mocked Matrix transport, including tampering, byte limits, cancellation, and outbox path restrictions. Restart tests cover owner-only commands and acknowledgement failures; real child-process tests verify sequential replacement, `.env` reload, and signal forwarding. Background-watch tests cover restart recovery, expired/malformed files, path checks, cancelled/reset sessions, busy delivery and uncertain admissions. HTTP tests exercise background registration and resumed delivery through both backend adapters. Live progress messages, background completions, confirmations, plugin/OAuth flows, steering, restart acknowledgement, attachment delivery, and rendering in Element require a separate check after upgrading the running connector. The Codex adapter was developed against the 0.159.1 App Server protocol. Codex is installed and updated independently of Riftjack; mock tests do not establish compatibility with every CLI release. Check the installed CLI’s generated App Server schemas when changing the protocol adapter, and verify a real task after a CLI upgrade.

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


For a local outgoing-media benchmark, create a regular test file and run:

```sh
node --import tsx scripts/benchmark-media.mts streamed /absolute/path/test.bin /absolute/path/streamed.json
node --import tsx scripts/benchmark-media.mts buffered /absolute/path/test.bin /absolute/path/buffered.json
```

Each command runs a separate Node process with a loopback HTTP receiver and verifies the received ciphertext hash. The report records elapsed time and kernel peak RSS, including the receiver. `buffered` reproduces the former whole-file encryption and SDK upload for comparison. These measurements do not include a Matrix homeserver or recipient download. Benchmark inputs and result files are local data; keep them outside the checkout.
