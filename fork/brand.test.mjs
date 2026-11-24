import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugins", "pstack");
const NAME = "fenix pstack";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("the Claude manifest carries the fork display name", () => {
  assert.equal(readJson(join(PLUGIN, ".claude-plugin", "plugin.json")).displayName, NAME);
});

test("the Codex manifest and the Codex marketplace carry the fork display name", () => {
  const codex = readJson(join(PLUGIN, ".codex-plugin", "plugin.json"));
  const marketplace = readJson(join(ROOT, ".agents", "plugins", "marketplace.json"));
  assert.equal(codex.interface.displayName, NAME);
  assert.equal(marketplace.interface.displayName, NAME);
});

test("the Codex icons point at fork icon files that exist", () => {
  const { composerIcon, logo } = readJson(join(PLUGIN, ".codex-plugin", "plugin.json")).interface;
  for (const icon of [composerIcon, logo]) {
    assert.match(icon, /^\.\/assets\/fenix-pstack-icon-\d+\.png$/);
    assert.ok(existsSync(join(PLUGIN, icon)), `${icon} is missing`);
  }
});

test("the fork icon files exist", () => {
  for (const size of [64, 256, 512]) {
    assert.ok(existsSync(join(PLUGIN, "assets", `fenix-pstack-icon-${size}.png`)), `${size}px icon is missing`);
  }
});
