# Commit messages

A useful commit message tells the next reader what changed and why. Write a short,
specific subject; add a body when the reason, tradeoff or validation needs more
explanation.

For example:

```text
Format confirmation commands as code
Keep workspace files when bot creation is declined
Fix Claude session recovery after a disconnect
```

Mention the component or integration when it helps explain the change. There is
no required prefix such as `fix:` or `feat:`.

## Attribution

Human collaborators are welcome in `Co-authored-by` trailers. For AI-assisted
work, describe the resulting change without adding generated-by footers, AI
co-author trailers or tool branding. This convention keeps the history focused
on the project; it does not imply that the work was done without AI assistance.

The check covers commit subjects, bodies and trailers. It does not change Git
author identities or cryptographic signatures.

## Set up the local check

After cloning, run this once from the repository directory:

```sh
npm run hooks:install
```

The hook checks each commit message and points to the line that needs attention.
If a message is rejected, edit it and commit again. The installer changes only
this repository and preserves existing hook setups; if it finds one, it explains
how to integrate the check manually.

To check your branch before opening a pull request:

```sh
node scripts/check-commit-message.mjs --range main..HEAD
```

You can also check a draft message with `--file /path/to/message.txt`, or all local
Git refs with `--all`. If a tool adds attribution automatically, adjust its local
settings so you do not have to remove it on every commit.

If the checker rejects an ordinary description of a change, report the example.
Its matching rules cover standard author trailers, known tool identities and
common English attribution templates. They do not interpret arbitrary wording
or enforce the policy in every language; review is still needed. Please keep the
checks enabled while resolving the issue.

## For maintainers

The **Commit policy / commit-messages** workflow checks commits introduced by a
pull request and its title and body, using the checker from the target branch.
The title and body matter because they may become the squash commit message.
Check the final message again if it is edited during merging.

To make this a merge requirement, configure the repository ruleset to require
pull requests and this status check, and restrict bypasses and direct pushes.
The workflow alone does not configure those settings. Review changes to the
checker and workflow with the same care as other repository controls.

Self-hosted Git servers can run an administrator-managed copy of the checker
from a `pre-receive` hook, using Node.js 24 or later:

```sh
exec node /opt/riftjack-commit-policy/check-commit-message.mjs --receive
```

This checks incoming commits before accepting a push, including reachable history
on new branches and tags. Review existing history before enabling it, and keep
the server copy outside the pushed repository.

[Back to development](development.md) · [Back to Riftjack](../README.md)
