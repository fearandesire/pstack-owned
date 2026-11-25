### Opening a PR

Invoked at the end of every other playbook.

Work from a git worktree off trunk, and keep unrelated work out of it. Rebase into small, landable commits. Run `/deslop` over the diff before commit. Before you commit, merge, or deploy from a worktree, list the live agents and stop every one that holds it, including grandchildren you never launched. Confirm each stop, then run `git status` and read the tree you are about to ship.

Title: `type(scope): imperative subject`, one clause in the present tense, under 72 characters, with no issue key and no trailing period. `type` is the one that matches the change, from `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, and `revert`, with `!` before the colon only for a breaking change. Name a real symbol when one carries the change.

Body: a guided tour, not a report. Use the repository's template and fill its sections in order with two or three short sentences each. The visible sections are `## Summary`, `## Guided tour`, `## Verified`, and `## Risk`, then the two collapsed toggles. `## Summary` says what is different after this merges, for whom, and why, and links the issue. `## Guided tour` lists where to look, in review order, three stops at most, and drops for a one-file diff. `## Verified` gives one line per check: the command, an arrow, the result. `## Risk` gives what it touches and how to undo it. `## Screenshots` and a one-line `## Docs` entry are optional: include each only when it applies, so no template renders an empty section. Anything longer goes in the two collapsed toggles: `Evidence` holds the issue, the spec or decision, related PRs, what you did not verify, and the command log; `Scope and rollout` holds what it covers, what it leaves out, the tradeoff taken, and the rollout and rollback.

Stack follow-ups by base branch. Open PRs ready, through the run's PR tool with `draft: false`. Without one, use `gh pr create` without `--draft`, or `origin pr create --status open` when Origin's CLI resolves the repository. Opening a PR does not start a babysit.
