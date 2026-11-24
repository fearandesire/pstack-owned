import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "pstack");
const SKILLS = join(PLUGIN, "skills");
const NAME = /^[a-z0-9-]{1,64}$/;
const MAX_DESCRIPTION = 1024;

function descriptionOf(name) {
  let text = "";
  try {
    text = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
  } catch {}
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const lines = front.split(/\r?\n/);
  const at = lines.findIndex((line) => /^description:/.test(line));
  if (at < 0) return "";
  const parts = [lines[at].replace(/^description:\s*/, "")];
  for (const line of lines.slice(at + 1)) {
    if (/^[A-Za-z0-9_-]+:/.test(line)) break;
    parts.push(line.trim());
  }
  return parts
    .join(" ")
    .replace(/^[>|][-+]?\s*/, "")
    .replace(/^(["'])([\s\S]*)\1$/, "$2")
    .trim();
}

function symlinks(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) return [full];
    return entry.isDirectory() ? symlinks(full) : [];
  });
}

const skills = readdirSync(SKILLS, { withFileTypes: true }).filter((entry) => entry.isDirectory());

test("the plugin ships skills", () => {
  assert.ok(skills.length > 0);
});

for (const { name } of skills) {
  test(`skill ${name} fits the mirror limits`, () => {
    assert.match(name, NAME, "folder name outside the mirror's accepted pattern");
    const description = descriptionOf(name);
    assert.ok(description, "SKILL.md has no description");
    assert.ok(
      description.length <= MAX_DESCRIPTION,
      `description is ${description.length} characters, over ${MAX_DESCRIPTION}`,
    );
  });
}

test("the plugin holds no symlink", () => {
  assert.deepEqual(symlinks(PLUGIN), []);
});
