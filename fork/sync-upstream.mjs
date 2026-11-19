#!/usr/bin/env node
// Merges michael-denyer/pstack-claude into this fork without losing the fork's
// changes. FORK.md describes the commands, the version rule and the weekly workflow.
// Requires git 2.40 or newer (merge-tree --write-tree --merge-base).
//
// Exit codes: 0 done, 1 "check --exit-code" found the fork behind, 2 refused or a
// person is needed, 3 a command or git call failed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = "fork/upstream.json";
const UPSTREAM_REF = "refs/fork-sync/upstream";
const UPSTREAM_NAME = "michael-denyer/pstack-claude";
const NOTES_HEADING = "## Fork release notes";
const UNRESOLVED = ", conflicts unresolved";
const PLACEHOLDER = "@@fork-sync-version@@";
const VERSION_FIELD = /("version"\s*:\s*)"\d+\.\d+\.\d+"/g;

class Stop extends Error {
  constructor(message, code = 3) {
    super(message);
    this.code = code;
  }
}

let root = process.cwd();

function git(args, { allow = [0] } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.error) throw result.error;
  if (!allow.includes(result.status)) {
    throw new Stop("git " + args.join(" ") + " failed (" + result.status + "): " + result.stderr.trim());
  }
  return result;
}

const out = (args, options) => git(args, options).stdout.trim();

function show(rev, path) {
  const result = git(["show", rev + ":" + path], { allow: [0, 128] });
  return result.status === 0 ? result.stdout : null;
}

export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) throw new Stop('not a MAJOR.MINOR.PATCH version: "' + text.trim() + '"');
  return match.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function chooseVersion(forkVersion, upstreamVersion) {
  if (compareVersions(upstreamVersion, forkVersion) > 0) return upstreamVersion.trim();
  const [major, minor, patch] = parseVersion(forkVersion);
  return major + "." + minor + "." + (patch + 1);
}

// Splits Markdown at its "## " headings, ignoring lines inside fenced code blocks.
export function splitSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let fence = null;
  lines.forEach((line, index) => {
    const [, mark, after] = line.match(/^ {0,3}(\x60{3,}|~{3,})(.*)/) ?? [];
    if (fence) {
      if (mark?.startsWith(fence) && !after.trim()) fence = null;
    } else if (mark) {
      fence = mark;
    } else if (line.startsWith("## ")) {
      sections.push({ heading: line, start: index, body: [] });
      return;
    }
    sections.at(-1)?.body.push(line);
  });
  for (const section of sections) section.body = section.body.join("\n").trim();
  return { lines, sections };
}

export function forkOnlySections(forkText, upstreamText, baseText) {
  const known = new Set([...splitSections(upstreamText).sections, ...splitSections(baseText).sections].map((s) => s.heading));
  return splitSections(forkText).sections.filter((section) => !known.has(section.heading));
}

// Puts fork release notes at the top of FORK.md's notes section, newest first, skipping headings already there.
export function addForkNotes(forkMd, sections) {
  const lines = forkMd.split("\n");
  if (!lines.includes(NOTES_HEADING)) lines.push("", NOTES_HEADING, "");
  const start = lines.indexOf(NOTES_HEADING);
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  const present = new Set(lines.slice(start + 1, end).filter((line) => line.startsWith("### ")).map((line) => line.slice(4).trim()));
  const fresh = sections.filter((section) => !present.has(section.heading.slice(3).trim()));
  if (!fresh.length) return forkMd;
  const block = fresh.map((section) => "### " + section.heading.slice(3).trim() + (section.body ? "\n\n" + section.body : ""));
  const tail = lines.slice(start + 1).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return lines.slice(0, start + 1).join("\n") + "\n\n" + block.join("\n\n") + "\n" + (tail ? "\n" + tail + "\n" : "");
}

export function withSyncHeading(upstreamChanges, { version, upstreamVersion, sha7 }) {
  const { lines, sections } = splitSections(upstreamChanges);
  if (!sections.length) throw new Stop('upstream CHANGES.md has no "## " heading');
  lines.splice(
    sections[0].start,
    0,
    "## " + version + " - fork sync of upstream " + upstreamVersion,
    "",
    "Merges upstream " + UPSTREAM_NAME + " " + upstreamVersion + " (" + sha7 + ") into fenix's fork. Fork changes are listed in [FORK.md](FORK.md).",
    "",
  );
  return lines.join("\n");
}

// Three-way merges a JSON file with every "version" value replaced by one placeholder, so only
// real edits can conflict. Returns the merged text with the placeholder set to version, or null.
function mergeJsonIgnoringVersion(path, base, upstream, version) {
  const texts = [show("HEAD", path), show(base, path), show(upstream, path)];
  if (texts.includes(null)) return null;
  const dir = mkdtempSync(join(tmpdir(), "fork-sync-"));
  try {
    const files = ["fork", "base", "upstream"].map((name, i) => {
      const file = join(dir, name);
      writeFileSync(file, texts[i].replace(VERSION_FIELD, '$1"' + PLACEHOLDER + '"'));
      return file;
    });
    const merged = spawnSync("git", ["merge-file", "-p", ...files], { encoding: "utf8", maxBuffer: 1 << 28 });
    return merged.status === 0 ? merged.stdout.replaceAll(PLACEHOLDER, version) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readConfig() {
  return JSON.parse(readFileSync(join(root, CONFIG), "utf8"));
}

function fetchUpstream(config) {
  git(["fetch", "--no-tags", "--quiet", config.remote, "+refs/heads/" + config.branch + ":" + UPSTREAM_REF]);
  return out(["rev-parse", UPSTREAM_REF]);
}

function range(base, upstream) {
  if (git(["merge-base", "--is-ancestor", base, upstream], { allow: [0, 1] }).status !== 0) {
    throw new Stop(CONFIG + " base " + base + " is not an ancestor of upstream " + upstream + ": upstream was rewritten, so set base by hand");
  }
  const known = new Set(splitSections(show(base, "CHANGES.md") ?? "").sections.map((s) => s.heading));
  return {
    commits: Number(out(["rev-list", "--count", base + ".." + upstream])),
    headings: splitSections(show(upstream, "CHANGES.md") ?? "").sections.map((s) => s.heading).filter((h) => !known.has(h)),
  };
}

function analyse(config, upstream) {
  const forkVersion = show("HEAD", "VERSION").trim();
  const upstreamVersion = show(upstream, "VERSION").trim();
  const version = chooseVersion(forkVersion, upstreamVersion);
  const merged = git(["merge-tree", "-z", "--write-tree", "--name-only", "--merge-base=" + config.base, "HEAD", upstream], { allow: [0, 1] });
  const [tree, ...rest] = merged.stdout.split("\0");
  const resolvedByTool = [];
  const conflicts = [];
  for (const path of rest.slice(0, rest.indexOf("")).filter(Boolean)) {
    const byRule = path === "VERSION" || path === "CHANGES.md";
    const json = path.endsWith(".json") && mergeJsonIgnoringVersion(path, config.base, upstream, version) !== null;
    (byRule || json ? resolvedByTool : conflicts).push(path);
  }
  return { tree, summary: { forkVersion, upstreamVersion, version, upstream, base: config.base, ...range(config.base, upstream), resolvedByTool, conflicts } };
}

function fail(message) {
  throw new Stop(message, 2);
}

function parseArgs(argv, flags, values) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags.includes(arg)) args[arg.slice(2)] = true;
    else if (values.includes(arg)) args[arg.slice(2)] = argv[++i] ?? fail(arg + " needs a value");
    else fail("unknown argument " + arg);
  }
  return args;
}

function check(argv) {
  const args = parseArgs(argv, ["--json", "--exit-code"], []);
  const config = readConfig();
  const upstream = fetchUpstream(config);
  if (config.base === upstream) {
    const upstreamVersion = show(upstream, "VERSION").trim();
    if (args.json) console.log(JSON.stringify({ state: "current", upstream, upstreamVersion }, null, 2));
    else console.log("current: the fork already includes upstream " + upstream.slice(0, 7) + " (" + upstreamVersion + ")");
    return 0;
  }
  const { summary } = analyse(config, upstream);
  if (args.json) {
    console.log(JSON.stringify({ state: "behind", ...summary }, null, 2));
  } else {
    console.log(
      [
        "behind: " + summary.commits + " upstream commits since " + config.base.slice(0, 7),
        "fork VERSION      " + summary.forkVersion,
        "upstream VERSION  " + summary.upstreamVersion + " (" + upstream.slice(0, 7) + ")",
        "fork would take   " + summary.version,
        "upstream release notes added since base:",
        ...(summary.headings.length ? summary.headings.map((h) => "  " + h) : ["  none"]),
        "conflicts resolved by the tool (" + summary.resolvedByTool.length + "):",
        ...summary.resolvedByTool.map((p) => "  " + p),
        "conflicts that need a person (" + summary.conflicts.length + "):",
        ...summary.conflicts.map((p) => "  " + p),
      ].join("\n"),
    );
  }
  if (!args["exit-code"]) return 0;
  return summary.conflicts.length ? 2 : 1;
}

function runStep(command, ran) {
  if (!command) return;
  console.log("$ " + command);
  const result = spawnSync("sh", ["-c", command], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Stop("command failed (" + result.status + "): " + command);
  ran.push(command);
}

function markerFiles() {
  const result = git(["grep", "-I", "-l", "-E", "^(<<<<<<< |>>>>>>> )", "--", ".", ":(exclude)fork"], { allow: [0, 1] });
  return result.stdout.split("\n").filter(Boolean);
}

function writeSummary(args, summary) {
  if (args.summary) writeFileSync(args.summary, JSON.stringify(summary, null, 2) + "\n");
}

function finish(args, config, summary, { message, merge }) {
  const ran = [];
  if (!summary.conflicts.length) {
    runStep(process.env.FORK_SYNC_INSTALL ?? "bun install --frozen-lockfile && bun install --frozen-lockfile --cwd plugins", ran);
    runStep(process.env.FORK_SYNC_GENERATE ?? "bun tools/generate.mjs", ran);
    if (!args["no-check"]) runStep(process.env.FORK_SYNC_CHECK ?? "bun tools/generate.mjs --check && bun test tests/", ran);
  }
  writeFileSync(join(root, CONFIG), JSON.stringify({ ...config, base: summary.upstream }, null, 2) + "\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", message]);
  const head = out(["rev-parse", "HEAD"]);
  if (merge && out(["rev-list", "--parents", "-n", "1", head]).split(" ").length !== 3) {
    throw new Stop(head + " does not have two parents");
  }
  writeSummary(args, { changed: true, ...summary, checks: ran });
  console.log("committed " + head.slice(0, 7) + ": " + message);
}

function update(argv) {
  const args = parseArgs(argv, ["--allow-conflicts", "--no-check", "--continue"], ["--summary"]);
  const mergeHeadFile = resolve(root, out(["rev-parse", "--git-path", "MERGE_HEAD"]));
  const merging = existsSync(mergeHeadFile);
  const config = readConfig();
  if (args.continue) return resume(args, config, merging);

  if (merging) fail("an unfinished merge is in progress: run npm run skills:update -- --continue, or git merge --abort");
  if (out(["status", "--porcelain"])) fail("the working tree is not clean: commit or stash first");

  const upstream = fetchUpstream(config);
  if (config.base === upstream) {
    const version = show("HEAD", "VERSION").trim();
    writeSummary(args, {
      changed: false,
      forkVersion: version,
      upstreamVersion: show(upstream, "VERSION").trim(),
      version,
      upstream,
      base: config.base,
      commits: 0,
      headings: [],
      resolvedByTool: [],
      conflicts: [],
      checks: [],
    });
    console.log("current: the fork already includes upstream " + upstream.slice(0, 7) + "; nothing changed");
    return 0;
  }

  const { tree, summary } = analyse(config, upstream);
  git(["read-tree", "-m", "-u", "HEAD", tree]);
  writeFileSync(mergeHeadFile, upstream + "\n");

  const upstreamChanges = show(upstream, "CHANGES.md") ?? fail("upstream has no CHANGES.md");
  const notes = forkOnlySections(show("HEAD", "CHANGES.md") ?? "", upstreamChanges, show(config.base, "CHANGES.md") ?? "");
  const forkMd = join(root, "FORK.md");
  writeFileSync(forkMd, addForkNotes(existsSync(forkMd) ? readFileSync(forkMd, "utf8") : "# Fork\n", notes));
  writeFileSync(join(root, "VERSION"), summary.version + "\n");
  writeFileSync(
    join(root, "CHANGES.md"),
    summary.version === summary.upstreamVersion ? upstreamChanges : withSyncHeading(upstreamChanges, { ...summary, sha7: upstream.slice(0, 7) }),
  );
  for (const path of summary.resolvedByTool.filter((p) => p.endsWith(".json"))) {
    writeFileSync(join(root, path), mergeJsonIgnoringVersion(path, config.base, upstream, summary.version));
  }

  const label = upstream.slice(0, 7) + " (" + summary.upstreamVersion + ")";
  if (summary.conflicts.length && !args["allow-conflicts"]) {
    writeSummary(args, { changed: true, ...summary, checks: [] });
    console.log("upstream " + label + " is merged into the working tree, uncommitted. These files need a person:");
    console.log(summary.conflicts.map((p) => "  " + p).join("\n"));
    console.log("resolve them, then run npm run skills:update -- --continue");
    return 2;
  }
  finish(args, config, { changed: true, ...summary }, {
    message: "Merge upstream " + UPSTREAM_NAME + " " + label + (summary.conflicts.length ? UNRESOLVED : " as " + summary.version),
    merge: true,
  });
  return 0;
}

// Finishes an uncommitted merge, or the commit that --allow-conflicts left with markers in it.
function resume(args, config, merging) {
  const subject = out(["log", "-1", "--format=%s"]);
  if (!merging && !(subject.startsWith("Merge upstream ") && subject.endsWith(UNRESOLVED))) fail("there is no unfinished upstream merge to continue");
  if (out(["ls-files", "-u"])) fail("files are still unmerged in the index: git add them once resolved");
  const marked = markerFiles();
  if (marked.length) fail("conflict markers remain in:\n" + marked.map((p) => "  " + p).join("\n"));

  const [forkRev, upstreamRev] = merging ? ["HEAD", "MERGE_HEAD"] : ["HEAD^1", "HEAD^2"];
  const upstream = out(["rev-parse", upstreamRev]);
  const upstreamVersion = show(upstream, "VERSION").trim();
  const version = readFileSync(join(root, "VERSION"), "utf8").trim();
  const summary = {
    forkVersion: show(forkRev, "VERSION").trim(),
    upstreamVersion,
    version,
    upstream,
    base: merging ? config.base : out(["merge-base", "HEAD^1", "HEAD^2"]),
    ...range(merging ? config.base : out(["merge-base", "HEAD^1", "HEAD^2"]), upstream),
    resolvedByTool: [],
    conflicts: [],
  };
  const label = upstream.slice(0, 7) + " (" + upstreamVersion + ")";
  finish(args, config, summary, {
    message: (merging ? "Merge upstream " : "Resolve conflicts of upstream ") + UPSTREAM_NAME + " " + label + " as " + version,
    merge: merging,
  });
  return 0;
}

export function prBody(summary, automerge = "") {
  const code = (text) => "\x60" + text + "\x60";
  const sha7 = summary.upstream.slice(0, 7);
  const lines = [
    "Merges upstream [" + UPSTREAM_NAME + "](https://github.com/" + UPSTREAM_NAME + ") " + summary.upstreamVersion + " (" + code(sha7) + ") into the fork.",
    "",
    "| | |",
    "| --- | --- |",
    "| Fork version before | " + summary.forkVersion + " |",
    "| Upstream version | " + summary.upstreamVersion + " |",
    "| Fork version after | " + summary.version + " |",
    "| Upstream commits | [" + summary.commits + "](https://github.com/" + UPSTREAM_NAME + "/compare/" + summary.base.slice(0, 7) + "..." + sha7 + ") |",
    "",
    "### Upstream release notes added",
    "",
    ...(summary.headings.length ? summary.headings.map((h) => "- " + code(h)) : ["- none"]),
    "",
  ];
  if (summary.resolvedByTool.length) {
    lines.push("### Resolved by the tool", "", ...summary.resolvedByTool.map((p) => "- " + code(p)), "");
  }
  if (summary.conflicts.length) {
    lines.push(
      "### Conflicts that need a person",
      "",
      ...summary.conflicts.map((p) => "- " + code(p)),
      "",
      "These files hold conflict markers. To resolve them:",
      "",
      "1. " + code("git fetch origin automation/upstream-sync && git switch automation/upstream-sync"),
      "2. Edit each file above and remove every marker line.",
      "3. " + code("npm run skills:update -- --continue"),
      "4. " + code("git push"),
      "5. Remove the " + code("upstream-conflict") + " label so the weekly run can resume.",
      "",
    );
  }
  lines.push("### Auto-merge", "", automerge || "Auto-merge status was not recorded.", "");
  return lines.join("\n");
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!["check", "update", "pr-body"].includes(command)) {
    fail("usage: sync-upstream.mjs check [--json] [--exit-code] | update [--allow-conflicts] [--no-check] [--summary <file>] | update --continue | pr-body --summary <file> [--automerge <text>]");
  }
  root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim() || root;
  const [major, minor] = (out(["--version"]).match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  if (major < 2 || (major === 2 && minor < 40)) fail("git 2.40 or newer is required (merge-tree --write-tree --merge-base)");
  if (command === "check") return check(rest);
  if (command === "update") return update(rest);
  const args = parseArgs(rest, [], ["--summary", "--automerge"]);
  if (!args.summary) fail("pr-body needs --summary <file>");
  process.stdout.write(prBody(JSON.parse(readFileSync(args.summary, "utf8")), args.automerge));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Stop ? error.message : error);
    process.exitCode = error instanceof Stop ? error.code : 3;
  }
}
