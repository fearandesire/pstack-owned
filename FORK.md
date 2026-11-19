# pstack-owned: fenix's fork

This is fenix's fork of [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude), the Claude Code port of Lauren Tan's pstack. It follows upstream and carries a short list of changes of its own. Every forked skill file is declared in [`tools/forks.json`](tools/forks.json), as [CONTRIBUTING.md](CONTRIBUTING.md#the-sync-boundary) describes.

## What the fork changes

- **Owner-led landing in Autopilot-full** (pull request 1, released as 0.9.134). Upstream stops Autopilot-full at merge-ready and leaves every merge to the operator. The fork lets the owner agent land authorized ordinary work itself, once independent verification, current-head checks, a service-enforced head guard and a confirmed merge readback all hold. Explicit holds, Autopilot-stack and deployment or promotion still stop short of landing. Three `fenix` rules in `tests/skill-rules.test.mjs` fail if a sync loses the change.
- **OpenCode plugin activation** (pull requests 2 and 3, released as 0.9.135). `opencode/index.js` awaited a skill transform inside `setup()`, which OpenCode only applies after `setup()` resolves, so activation never finished and every model-catalog request failed with HTTP 503. Setup no longer waits for the transform, and a rejected transform is logged and skips routing instead of failing the turn. `tests/opencode.test.mjs` covers both paths.

## Syncing from upstream

`fork/upstream.json` records the upstream remote, its branch and `base`, the upstream commit the fork last merged. The tool merges with that explicit base, so the result is right whether a sync pull request lands as a merge commit or as a squash. It needs git 2.40 or newer.

| Command | What it does |
| --- | --- |
| `npm run skills:check` | Fetches upstream into `refs/fork-sync/upstream` and reports whether the fork is current. When it is behind, it prints the fork and upstream versions, the version the fork would take, the commits behind, the upstream release notes added since `base`, and the conflicted files split into "resolved by the tool" and "needs a person". It writes no tracked file. |
| `npm run skills:update` | Merges upstream into the working tree, resolves what the rules below cover, runs the install, generator and checks, and commits a merge with upstream as its second parent. |

Flags:

- `check --json` prints the report as JSON. `check --exit-code` exits 1 when the fork is behind and 2 when a person is needed, and 0 otherwise.
- `update --allow-conflicts` commits even when files need a person, with the conflict markers in them, and lists the files in the summary. The weekly workflow uses it.
- `update --no-check` skips `bun tools/generate.mjs --check` and `bun test tests/`.
- `update --summary <file>` writes the result as JSON.
- `update --continue` finishes a merge after a person has fixed the marked files.
- `pr-body --summary <file> [--automerge <text>]` prints the sync pull request's description.

`update` exits 2 and changes nothing on a dirty tree or while a merge is unfinished. With nothing behind it reports `changed: false` and exits 0, so a second run does nothing. When real conflicts remain and `--allow-conflicts` is off, it leaves the merge uncommitted, lists the files and exits 2. Other exit codes: 3 when a command or git call fails.

`FORK_SYNC_INSTALL`, `FORK_SYNC_GENERATE` and `FORK_SYNC_CHECK` replace the install, generator and check commands. The tests use them on small fixture repositories.

### What the tool resolves itself

- **`VERSION`.** Upstream's version when it is higher than the fork's, else the fork's version with the patch number raised by one. The generator then stamps the version into every manifest.
- **`CHANGES.md`.** Always upstream's file, because the generator requires its newest heading to match `VERSION` and the fork would otherwise conflict on every release. When the chosen version is not upstream's, the tool adds a `## <version> - fork sync of upstream <upstream version>` entry above upstream's first one. Each section the fork's file has that neither upstream's nor the base's file has is a fork release note: it moves to the **Fork release notes** section below, newest first, and is skipped when its heading is already there.
- **Version-stamped `.json` files.** The three-way merge runs again with every `"version"` value replaced by one placeholder, so only real edits conflict. A clean result is written with the chosen version in place; an unclean one stays a conflict for a person.

Every other conflicted file needs a person. The tool never picks a side for skill text.

## Weekly sync workflow

`.github/workflows/fork-upstream-sync.yml` ("Sync from upstream") runs on Mondays at 07:41 UTC and on demand. It starts from `main`, runs `update --allow-conflicts` on the branch `automation/upstream-sync`, force-pushes that branch and opens or updates the pull request. It stops early while an open sync pull request carries the `upstream-conflict` label.

- **No conflicts.** The workflow starts the "Fork gate" workflow on the branch, because a pull request opened with `GITHUB_TOKEN` does not start `pull_request` workflows. It enables auto-merge (a merge commit) only when the `main` branch rules include a required status check and the pull request's head branch is `automation/upstream-sync` in this repository. Otherwise the pull request stays open, and its description and the job summary say why.
- **Conflicts.** The branch holds a commit with conflict markers in the files the tool could not resolve. The workflow labels the pull request `upstream-conflict`, lists the files in its description and leaves auto-merge off. The "Fork gate" check fails on those markers, so the pull request cannot merge by accident.

The workflow pushes with `GITHUB_TOKEN`, which GitHub refuses to let change files under `.github/workflows/`. A sync whose upstream range touches a workflow file therefore fails at the push step: run `npm run skills:update` locally and push the branch yourself.

`.github/workflows/fork-gate.yml` ("Fork gate", job `fork-gate`) is the check the branch rule requires. It runs the generated-files job's steps from `ci.yml`, fails on a conflict-marker line in any tracked file outside `fork/`, and runs the sync tool's tests.

## Resolving a conflict pull request

1. Check out the branch: `git fetch origin automation/upstream-sync && git switch automation/upstream-sync`.
2. Fix every file the pull request lists. Remove every marker line.
3. Run `npm run skills:update -- --continue`. It refuses while a marker remains, then installs, regenerates, checks and commits.
4. Push the branch with `git push`.
5. Remove the `upstream-conflict` label, so the next weekly run can update the branch again.

## Fork release notes
