import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skillsDir = join(root, "skills");

function readSkills() {
  return readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const path = join(skillsDir, entry.name, "SKILL.md");
    const text = readFileSync(path, "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Error(`Missing skill frontmatter: ${path}`);
    const metadata = Bun.YAML.parse(match[1]);
    return { id: `pstack-${entry.name}`, name: metadata.name, description: metadata.description, path, content: text.slice(match[0].length) };
  });
}

function hookEnabled() {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  try {
    const bytes = readFileSync(join(config, "opencode", "pstack-models.md"));
    const text = bytes[0] === 0xff && bytes[1] === 0xfe
      ? new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(bytes)
      : bytes.toString("utf8");
    return !text.replace(/^\uFEFF/, "").split(/\r?\n/).includes("session hook: off");
  } catch {
    return true;
  }
}

export default {
  id: "pstack",
  async setup(ctx) {
    const skills = readSkills();
    const mandate = readFileSync(join(root, "hooks", "session-start-opencode.md"), "utf8");
    // OpenCode applies skill transforms only after setup() settles, so awaiting
    // transform() here deadlocks activation and the model catalog request fails
    // with "Location plugins did not finish activating". The session hook
    // logs a transform failure and skips injection instead.
    let skillTransformError;
    const transformAttempt = Promise.resolve().then(() => ctx.skill.transform((editor) => {
      for (const skill of skills) if (!editor.get(skill.id)) editor.add(skill);
    })).catch((error) => { skillTransformError = error; });
    await ctx.session.hook("context", async (event) => {
      await transformAttempt;
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (session.parentID || !hookEnabled()) return;
      if (skillTransformError) {
        console.error("pstack: OpenCode skill registration failed:", skillTransformError);
        return;
      }
      const installed = new Map((await ctx.skill.list()).data.map((skill) => [skill.id, skill.path]));
      if (skills.some((skill) => installed.get(skill.id) !== skill.path)) return;
      event.system.push({ type: "text", text: mandate });
    });
  },
};
