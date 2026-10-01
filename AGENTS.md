# Project stage

Riftjack is in early development. Prefer one current configuration and command
interface. Do not retain superseded names, compatibility aliases or historical
migration notes without a concrete need.

# Public text and examples

Use English for built-in messages, help and documentation. This does not set the
language of agent conversations or restrict Unicode names, paths or content.
Use neutral, self-contained examples such as `projects/demo` and `@alice:example.com`.
Do not copy personal conversation details, private project names or deployment
paths into fixtures or examples. Preserve real project attribution and links.
Bot avatars and their generation prompts are instance data; keep them outside
the repository, under the instance's `data/avatars/` directory.

Keep multilingual fixtures where they exercise Unicode or language handling.
Prefer behavior and data assertions to exact prose or incidental whitespace;
assert visible wording when it is itself the behavior under test.

# Commit messages

Describe the change and its purpose. Do not add AI attribution to commit subjects,
bodies or trailers: no "Generated with", AI co-author credits, assistant signatures,
or tool branding. Human co-author credits are permitted. Ordinary discussion of
Claude, Codex and other integrations in a change description is permitted.

Do not bypass commit policy hooks or CI. If a message fails the policy, revise the
message. After initializing/cloning this repository, run `npm run hooks:install`.
See `docs/commit-policy.md` for policy scope and server enforcement.

# Test selection

Run `npm test` and `npm run check` in the normal sandbox; the default test suite
must not open listening ports. Keep port-opening tests in `test/http/` and run
them with `npm run test:http` when changing the publication MCP transport or its backend integration, the worker HTTP API, its Python
client, queue/service behavior exposed by that API, or related dependencies and
test infrastructure. Do not request broader permissions for the ordinary suite
just because HTTP tests exist. `npm run test:all` explicitly runs both suites.
See `docs/development.md` for the test scope and local-port requirements.
