import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { addForkNotes, chooseVersion, forkOnlySections, prBody, splitSections } from "./sync-upstream.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sync-upstream.mjs");
const GENERATOR = [
  'import { readFileSync, writeFileSync } from "node:fs";',
  'const version = readFileSync("VERSION", "utf8").trim();',
  'for (const file of ["package.json", "manifest.json"]) {',
  '  writeFileSync(file, readFileSync(file, "utf8").replace(/("version": )"[^"]*"/, "$1\\"" + version + "\\""));',
  "}",
  "",
].join("\n");
const ENV = {
  ...process.env,
  FORK_SYNC_INSTALL: "",
  FORK_SYNC_GENERATE: "node tools/gen.mjs",
  FORK_SYNC_CHECK: "test -f VERSION",
};
const temporary = [];
after(() => temporary.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: ENV });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd, ...args) {
  const result = run(cwd, "git", args);
  assert.equal(result.status, 0, "git " + args.join(" ") + ": " + result.stderr);
  return result.stdout.trim();
}

const sync = (cwd, ...args) => run(cwd, "node", [SCRIPT, ...args]);
const read = (cwd, file) => readFileSync(join(cwd, file), "utf8");

function put(cwd, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
}

function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function manifest(version, description = "fixture") {
  return '{\n  "name": "fixture",\n  "version": "' + version + '",\n  "description": "' + description + '"\n}\n';
}

// A release the way upstream makes one: VERSION, a CHANGES.md entry, and the stamped manifests.
function release(cwd, version, title, files = {}) {
  const changes = read(cwd, "CHANGES.md").replace("\n## ", "\n## " + version + " - " + title + "\n\nNotes for " + version + ".\n\n## ");
  const stamp = (file) => read(cwd, file).replace(/("version": )"[^"]*"/, '$1"' + version + '"');
  put(cwd, { VERSION: version + "\n", "CHANGES.md": changes, "package.json": stamp("package.json"), "manifest.json": stamp("manifest.json"), ...files });
  return commitAll(cwd, "release " + version);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fork-sync-test-"));
  temporary.push(dir);
  const upstream = join(dir, "upstream");
  const fork = join(dir, "fork");
  for (const repo of [upstream]) {
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    git(repo, "config", "user.name", "Upstream");
    git(repo, "config", "user.email", "upstream@example.com");
    git(repo, "config", "commit.gpgsign", "false");
  }
  put(upstream, {
    VERSION: "1.0.0\n",
    "CHANGES.md": "# CHANGES\n\nIntro.\n\n## 1.0.0 - first\n\nFirst release.\n",
    "package.json": manifest("1.0.0"),
    "manifest.json": manifest("1.0.0"),
    "src/app.txt": "one\ntwo\nthree\n",
    "tools/gen.mjs": GENERATOR,
  });
  const base = commitAll(upstream, "first");
  git(dir, "clone", "--quiet", upstream, fork);
  git(fork, "config", "user.name", "Fork");
  git(fork, "config", "user.email", "fork@example.com");
  git(fork, "config", "commit.gpgsign", "false");
  put(fork, {
    "fork/upstream.json": JSON.stringify({ remote: upstream, branch: "main", base }, null, 2) + "\n",
    "FORK.md": "# Fork\n\n## Fork release notes\n",
  });
  commitAll(fork, "fork setup");
  return { upstream, fork, base };
}

const parents = (cwd, rev = "HEAD") => git(cwd, "rev-list", "--parents", "-n", "1", rev).split(" ").length - 1;
const count = (text, needle) => text.split(needle).length - 1;

describe("version rule", () => {
  test("takes upstream's version when it is higher, else the fork's patch plus one", () => {
    assert.equal(chooseVersion("0.9.135", "0.9.140"), "0.9.140");
    assert.equal(chooseVersion("1.5.0", "1.1.0"), "1.5.1");
    assert.equal(chooseVersion("1.1.0", "1.1.0"), "1.1.1");
    assert.equal(chooseVersion("1.9.9", "1.10.0"), "1.10.0");
  });

  test("ignores headings inside fenced code", () => {
    const text = "# T\n\n## 1.0.0 - a\n\nbody\n\n" + "\x60\x60\x60\n## not a heading\n\x60\x60\x60\n\n## 0.9.0 - b\n\nold\n";
    assert.deepEqual(splitSections(text).sections.map((s) => s.heading), ["## 1.0.0 - a", "## 0.9.0 - b"]);
  });

  test("keeps fork-only sections and skips notes FORK.md already holds", () => {
    const only = forkOnlySections("## 2.0.0 - fork\n\nmine\n\n## 1.0.0 - first\n\nx\n", "## 1.0.0 - first\n\nx\n", "## 0.9.0 - old\n");
    assert.deepEqual(only.map((s) => s.heading), ["## 2.0.0 - fork"]);
    const once = addForkNotes("# Fork\n\n## Fork release notes\n", only);
    assert.equal(once, "# Fork\n\n## Fork release notes\n\n### 2.0.0 - fork\n\nmine\n");
    assert.equal(addForkNotes(once, only), once);
  });
});

describe("check", () => {
  test("reports current, behind and what needs a person with the exit codes", () => {
    const { upstream, fork } = fixture();
    const current = sync(fork, "check", "--exit-code");
    assert.equal(current.status, 0);
    assert.match(current.stdout, /^current/);

    release(upstream, "1.1.0", "second");
    const behind = sync(fork, "check", "--exit-code", "--json");
    assert.equal(behind.status, 1);
    const report = JSON.parse(behind.stdout);
    assert.deepEqual([report.state, report.forkVersion, report.upstreamVersion, report.version, report.commits], ["behind", "1.0.0", "1.1.0", "1.1.0", 1]);
    assert.deepEqual(report.headings, ["## 1.1.0 - second"]);
    assert.deepEqual(report.conflicts, []);
    assert.equal(sync(fork, "check").status, 0);
    assert.equal(git(fork, "status", "--porcelain"), "");

    put(upstream, { "src/app.txt": "one\nUP\nthree\n" });
    commitAll(upstream, "edit");
    put(fork, { "src/app.txt": "one\nFORK\nthree\n" });
    commitAll(fork, "fork edit");
    const person = sync(fork, "check", "--exit-code", "--json");
    assert.equal(person.status, 2);
    assert.deepEqual(JSON.parse(person.stdout).conflicts, ["src/app.txt"]);
  });

  test("leaves a real edit conflict in a manifest to a person", () => {
    const { upstream, fork } = fixture();
    put(upstream, { "package.json": manifest("1.0.0", "upstream words") });
    release(upstream, "1.1.0", "second");
    put(fork, { "package.json": manifest("1.0.0", "fork words") });
    commitAll(fork, "fork description");
    const report = JSON.parse(sync(fork, "check", "--json").stdout);
    assert.deepEqual(report.conflicts, ["package.json"]);
  });
});

describe("update", () => {
  test("merges cleanly, records upstream as the second parent, and a second run changes nothing", () => {
    const { upstream, fork } = fixture();
    put(fork, { "fork-only.txt": "mine\n" });
    commitAll(fork, "fork change");
    const tip = release(upstream, "1.1.0", "second", { "src/new.txt": "new\n" });
    const summaryFile = join(fork, "..", "summary.json");

    const result = sync(fork, "update", "--summary", summaryFile);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(parents(fork), 2);
    assert.equal(git(fork, "rev-parse", "HEAD^2"), tip);
    assert.equal(read(fork, "VERSION"), "1.1.0\n");
    assert.match(read(fork, "package.json"), /"version": "1.1.0"/);
    assert.equal(read(fork, "fork-only.txt"), "mine\n");
    assert.equal(read(fork, "src/new.txt"), "new\n");
    assert.equal(JSON.parse(read(fork, "fork/upstream.json")).base, tip);
    assert.match(git(fork, "log", "-1", "--format=%s"), /^Merge upstream michael-denyer\/pstack-claude [0-9a-f]{7} \(1\.1\.0\) as 1\.1\.0$/);
    const summary = JSON.parse(read(fork, "../summary.json"));
    assert.deepEqual([summary.changed, summary.version, summary.upstream, summary.commits, summary.conflicts], [true, "1.1.0", tip, 1, []]);

    const head = git(fork, "rev-parse", "HEAD");
    const again = sync(fork, "update", "--summary", summaryFile);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /^current/);
    assert.equal(JSON.parse(read(fork, "../summary.json")).changed, false);
    assert.equal(git(fork, "rev-parse", "HEAD"), head);
    assert.equal(git(fork, "status", "--porcelain"), "");
    assert.equal(sync(fork, "check").status, 0);
  });

  test("resolves a version-only conflict, takes upstream's CHANGES.md and moves the fork's release note to FORK.md", () => {
    const { upstream, fork } = fixture();
    release(fork, "1.0.1", "fork fix");
    const tip = release(upstream, "1.1.0", "second");

    const result = sync(fork, "update");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(read(fork, "VERSION"), "1.1.0\n");
    assert.equal(read(fork, "CHANGES.md"), git(fork, "show", tip + ":CHANGES.md") + "\n");
    assert.match(read(fork, "FORK.md"), /## Fork release notes\n\n### 1\.0\.1 - fork fix\n\nNotes for 1\.0\.1\.\n/);
    assert.match(read(fork, "package.json"), /"version": "1\.1\.0"/);
    assert.equal(git(fork, "status", "--porcelain"), "");
  });

  test("never duplicates a fork release note on a later run", () => {
    const { upstream, fork } = fixture();
    const note = (version) => read(fork, "CHANGES.md").replace("\n## ", "\n## " + version + " - fork fix\n\nThe fork fix.\n\n## ");
    put(fork, { "CHANGES.md": note("1.0.1") });
    commitAll(fork, "fork note");
    release(upstream, "1.1.0", "second");
    assert.equal(sync(fork, "update").status, 0);
    assert.equal(count(read(fork, "FORK.md"), "### 1.0.1 - fork fix"), 1);

    put(fork, { "CHANGES.md": note("1.0.1") });
    commitAll(fork, "the same note comes back");
    release(upstream, "1.2.0", "third");
    assert.equal(sync(fork, "update").status, 0);
    assert.equal(count(read(fork, "FORK.md"), "### 1.0.1 - fork fix"), 1);
    assert.equal(read(fork, "VERSION"), "1.2.0\n");
  });

  test("keeps the fork's version, plus one patch, when upstream's is not higher", () => {
    const { upstream, fork } = fixture();
    release(fork, "1.5.0", "fork release");
    const tip = release(upstream, "1.1.0", "second");

    const result = sync(fork, "update");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(read(fork, "VERSION"), "1.5.1\n");
    assert.match(read(fork, "package.json"), /"version": "1\.5\.1"/);
    const sha7 = tip.slice(0, 7);
    assert.match(
      read(fork, "CHANGES.md"),
      new RegExp("^# CHANGES\\n\\nIntro\\.\\n\\n## 1\\.5\\.1 - fork sync of upstream 1\\.1\\.0\\n\\nMerges upstream michael-denyer/pstack-claude 1\\.1\\.0 \\(" + sha7 + "\\) into fenix's fork\\. Fork changes are listed in \\[FORK\\.md\\]\\(FORK\\.md\\)\\.\\n\\n## 1\\.1\\.0 - second"),
    );
    assert.match(git(fork, "log", "-1", "--format=%s"), /\(1\.1\.0\) as 1\.5\.1$/);
  });

  test("stops on a real conflict, then --continue finishes after a person fixes it", () => {
    const { upstream, fork } = fixture();
    put(fork, { "src/app.txt": "one\nFORK\nthree\n" });
    const forkTip = commitAll(fork, "fork edit");
    put(upstream, { "src/app.txt": "one\nUP\nthree\n" });
    const tip = release(upstream, "1.1.0", "second");

    const stopped = sync(fork, "update");
    assert.equal(stopped.status, 2);
    assert.match(stopped.stdout, /src\/app\.txt/);
    assert.match(stopped.stdout, /resolve them, then run npm run skills:update -- --continue/);
    assert.equal(git(fork, "rev-parse", "HEAD"), forkTip);
    assert.equal(git(fork, "rev-parse", "MERGE_HEAD"), tip);
    assert.match(read(fork, "src/app.txt"), /^<<<<<<< /m);
    assert.equal(JSON.parse(read(fork, "fork/upstream.json")).base === tip, false);

    assert.equal(sync(fork, "update").status, 2);
    const early = sync(fork, "update", "--continue");
    assert.equal(early.status, 2);
    assert.match(early.stderr, /src\/app\.txt/);

    put(fork, { "src/app.txt": "one\nBOTH\nthree\n" });
    const done = sync(fork, "update", "--continue");
    assert.equal(done.status, 0, done.stderr + done.stdout);
    assert.equal(parents(fork), 2);
    assert.equal(git(fork, "rev-parse", "HEAD^2"), tip);
    assert.equal(read(fork, "src/app.txt"), "one\nBOTH\nthree\n");
    assert.equal(JSON.parse(read(fork, "fork/upstream.json")).base, tip);
    assert.equal(sync(fork, "check").stdout.startsWith("current"), true);
  });

  test("--allow-conflicts commits the markers and lists the files, and --continue follows up", () => {
    const { upstream, fork } = fixture();
    put(fork, { "src/app.txt": "one\nFORK\nthree\n" });
    commitAll(fork, "fork edit");
    put(upstream, { "src/app.txt": "one\nUP\nthree\n" });
    const tip = release(upstream, "1.1.0", "second");
    const summaryFile = join(fork, "..", "summary.json");

    const result = sync(fork, "update", "--allow-conflicts", "--summary", summaryFile);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(parents(fork), 2);
    assert.match(git(fork, "log", "-1", "--format=%s"), /^Merge upstream michael-denyer\/pstack-claude [0-9a-f]{7} \(1\.1\.0\), conflicts unresolved$/);
    assert.match(read(fork, "src/app.txt"), /^<<<<<<< /m);
    assert.equal(JSON.parse(read(fork, "fork/upstream.json")).base, tip);
    const summary = JSON.parse(read(fork, "../summary.json"));
    assert.deepEqual([summary.changed, summary.conflicts], [true, ["src/app.txt"]]);
    assert.equal(git(fork, "status", "--porcelain"), "");
    assert.equal(sync(fork, "update").stdout.startsWith("current"), true);

    assert.equal(sync(fork, "update", "--continue").status, 2);
    put(fork, { "src/app.txt": "one\nBOTH\nthree\n" });
    const done = sync(fork, "update", "--continue");
    assert.equal(done.status, 0, done.stderr + done.stdout);
    assert.equal(parents(fork), 1);
    assert.match(git(fork, "log", "-1", "--format=%s"), /^Resolve conflicts of upstream michael-denyer\/pstack-claude [0-9a-f]{7} \(1\.1\.0\) as 1\.1\.0$/);
    assert.equal(git(fork, "rev-parse", "HEAD~1^2"), tip);
    assert.equal(read(fork, "src/app.txt"), "one\nBOTH\nthree\n");
    assert.equal(sync(fork, "update", "--continue").status, 2);
  });

  test("merges from the recorded base after a previous sync landed as a squash", () => {
    const { upstream, fork } = fixture();
    const first = release(upstream, "1.1.0", "second", { "src/a.txt": "a1\n" });
    git(fork, "fetch", "--quiet", upstream, "main");
    git(fork, "merge", "--squash", "--quiet", first);
    put(fork, { "fork/upstream.json": JSON.stringify({ ...JSON.parse(read(fork, "fork/upstream.json")), base: first }, null, 2) + "\n" });
    commitAll(fork, "sync as a squash");
    assert.equal(parents(fork), 1);

    put(upstream, { "src/a.txt": "a1\na2\n", "src/b.txt": "b\n" });
    const second = release(upstream, "1.2.0", "third");
    assert.equal(run(fork, "git", ["merge-tree", "--write-tree", "HEAD", second]).status, 1);

    const result = sync(fork, "update");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(parents(fork), 2);
    assert.equal(read(fork, "src/a.txt"), "a1\na2\n");
    assert.equal(read(fork, "src/b.txt"), "b\n");
    assert.equal(read(fork, "VERSION"), "1.2.0\n");
  });

  test("refuses a dirty tree and an unknown argument", () => {
    const { upstream, fork } = fixture();
    release(upstream, "1.1.0", "second");
    put(fork, { "stray.txt": "x\n" });
    const dirty = sync(fork, "update");
    assert.equal(dirty.status, 2);
    assert.match(dirty.stderr, /not clean/);
    assert.equal(sync(fork, "update", "--bogus").status, 2);
  });
});

describe("pr-body", () => {
  test("lists versions, upstream notes, the conflicts with the resolve steps, and the auto-merge line", () => {
    const { upstream, fork } = fixture();
    put(fork, { "src/app.txt": "one\nFORK\nthree\n" });
    commitAll(fork, "fork edit");
    put(upstream, { "src/app.txt": "one\nUP\nthree\n" });
    release(upstream, "1.1.0", "second");
    const summaryFile = join(fork, "..", "summary.json");
    assert.equal(sync(fork, "update", "--allow-conflicts", "--summary", summaryFile).status, 0);

    const body = sync(fork, "pr-body", "--summary", summaryFile, "--automerge", "Auto-merge off: conflicts.").stdout;
    assert.match(body, /Fork version before \| 1\.0\.0/);
    assert.match(body, /Fork version after \| 1\.1\.0/);
    assert.match(body, /## 1\.1\.0 - second/);
    assert.match(body, /Conflicts that need a person[\s\S]*src\/app\.txt/);
    assert.match(body, /npm run skills:update -- --continue/);
    assert.match(body, /upstream-conflict/);
    assert.match(body, /Auto-merge off: conflicts\./);
    assert.equal(prBody({ ...JSON.parse(read(fork, "../summary.json")), conflicts: [] }, "x").includes("Conflicts that need a person"), false);
  });
});
