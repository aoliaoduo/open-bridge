/**
 * Unit tests for skill discovery: the front-matter contract, the lookup order,
 * and the bounds that keep this usable on the request path. The end-to-end
 * behaviour (instructions, the tool, reading a skill) lives in
 * test/skills-integration.test.mjs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  MAX_DESCRIPTION_CHARS, MAX_SKILLS, SKILL_FILE,
  discoverSkills, parseSkillFile, skillDirs, skillsIndexSuffix,
} from "../src/bridge/skills.js";

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "ob-skills-"));
}

function addSkill(root: string, relDir: string, content: string): string {
  const dir = path.join(root, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, SKILL_FILE), content);
  return path.join(dir, SKILL_FILE);
}

test("front matter supplies the name and the description", () => {
  const parsed = parseSkillFile("---\nname: release\ndescription: Cut a release\n---\n\n# Body\n", "fallback");
  assert.equal(parsed.name, "release");
  assert.equal(parsed.description, "Cut a release");
});

test("quoted values, CRLF and extra keys do not break the parse", () => {
  const parsed = parseSkillFile('---\r\nname: "deploy"\r\nallowed-tools: Bash\r\ndescription: \'Ship it\'\r\n---\r\nBody\r\n', "fallback");
  assert.equal(parsed.name, "deploy");
  assert.equal(parsed.description, "Ship it");
});

test("without front matter the heading names it and the first prose line describes it", () => {
  const parsed = parseSkillFile("# House style\n\nUse tabs. Never force push.\n", "folder-name");
  assert.equal(parsed.name, "House style");
  assert.equal(parsed.description, "Use tabs. Never force push.");
});

test("an unterminated front matter block falls back instead of swallowing the file", () => {
  const parsed = parseSkillFile("---\nname: half\nno closing fence\n", "folder-name");
  assert.equal(parsed.name, "folder-name", "the folder name is the safe fallback");
  assert.match(parsed.description, /no closing fence/, "the metadata lines are not mistaken for prose");
});

test("a bare file with no heading falls back to the folder name and stays bounded", () => {
  const parsed = parseSkillFile("x".repeat(500), "folder-name");
  assert.equal(parsed.name, "folder-name");
  assert.equal(parsed.description.length, MAX_DESCRIPTION_CHARS);
});

test("skills are found in all three workspace spellings plus the extra directory", () => {
  const root = workspace();
  try {
    addSkill(root, "skills/plain", "---\nname: plain\ndescription: d1\n---\n");
    addSkill(root, ".agents/skills/agents-style", "---\nname: agents-style\ndescription: d2\n---\n");
    addSkill(root, ".claude/skills/claude-style", "---\nname: claude-style\ndescription: d3\n---\n");
    const extra = path.join(root, "data");
    mkdirSync(extra, { recursive: true });
    addSkill(extra, "skills/user-level", "---\nname: user-level\ndescription: d4\n---\n");
    const found = discoverSkills({ root, extraDirs: [extra], home: path.join(root, "__home") });
    // Deterministic: directory order first (workspace, then extra, then user),
    // then alphabetical inside each directory.
    assert.deepEqual(found.skills.map(s => s.name), ["plain", "agents-style", "claude-style", "user-level"]);
    assert.equal(found.shadowed, 0);
    // This extra directory sits inside the workspace, so nothing is flagged;
    // the dedicated test below covers a directory outside it.
    assert.deepEqual(found.skills.map(s => s.outside_workspace), [false, false, false, false]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the workspace wins a name clash and the loser is counted, not hidden", () => {
  const root = workspace();
  try {
    addSkill(root, "skills/release", "---\nname: release\ndescription: project rules\n---\n");
    const extra = path.join(root, "data");
    addSkill(extra, "skills/release", "---\nname: release\ndescription: user rules\n---\n");
    const found = discoverSkills({ root, extraDirs: [extra], home: path.join(root, "__home") });
    assert.equal(found.skills.length, 1);
    assert.equal(found.skills[0].description, "project rules");
    assert.equal(found.shadowed, 1);
    assert.equal(found.skills[0].outside_workspace, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a folder without SKILL.md, hidden folders, and absent roots are all ignored", () => {
  const root = workspace();
  try {
    mkdirSync(path.join(root, "skills", "not-a-skill"), { recursive: true });
    mkdirSync(path.join(root, "skills", ".hidden"), { recursive: true });
    writeFileSync(path.join(root, "skills", ".hidden", SKILL_FILE), "---\nname: hidden\n---\n");
    const found = discoverSkills({ root, home: path.join(root, "__home") });
    assert.deepEqual(found.skills, []);
    assert.deepEqual(found.scanned, [path.join(root, "skills")], "only directories that exist are reported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the count is bounded so a runaway directory cannot flood the instructions", () => {
  const root = workspace();
  try {
    for (let i = 0; i < MAX_SKILLS + 5; i += 1) {
      addSkill(root, `skills/skill-${String(i).padStart(3, "0")}`, `---\nname: skill-${i}\ndescription: d\n---\n`);
    }
    const found = discoverSkills({ root, home: path.join(root, "__home") });
    assert.equal(found.skills.length, MAX_SKILLS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outside the workspace is flagged, so the index can say where it came from", () => {
  const root = workspace();
  try {
    const extra = mkdtempSync(path.join(tmpdir(), "ob-skills-data-"));
    addSkill(extra, "skills/global", "---\nname: global\ndescription: d\n---\n");
    const found = discoverSkills({ root, extraDirs: [extra], home: path.join(root, "__home") });
    assert.equal(found.skills.length, 1);
    assert.equal(found.skills[0].outside_workspace, true);
    assert.equal(found.skills[0].dir, path.dirname(path.join(extra, "skills", "global", SKILL_FILE)));
    rmSync(extra, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the instruction index names each skill with its path, and nothing at all when empty", () => {
  assert.equal(skillsIndexSuffix([]), "", "no skills means no injected block");
  const suffix = skillsIndexSuffix([{ name: "release", description: "Cut a release", path: "C:/p/SKILL.md", dir: "skills/release", outside_workspace: false }]);
  assert.match(suffix, /# Available skills/);
  assert.match(suffix, /- release — Cut a release \(C:\/p\/SKILL\.md\)/);
  assert.match(suffix, /read_files/);
});

test("the index caps its lines and points at list_skills for the rest", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    name: `s${i}`, description: "d", path: `C:/p/${i}/SKILL.md`, dir: `skills/s${i}`, outside_workspace: false,
  }));
  const suffix = skillsIndexSuffix(many);
  assert.match(suffix, /- s0 —/);
  assert.doesNotMatch(suffix, /- s24 —/, "the 25th entry is not injected");
  assert.match(suffix, /…and 5 more \(call list_skills\)/);
});

test("skillDirs keeps the workspace first so a project can shadow a user skill", () => {
  const dirs = skillDirs("C:/work", ["C:/data"], "C:/home");
  assert.deepEqual(dirs.slice(0, 4), [
    path.join("C:/work", "skills"),
    path.join("C:/work", ".agents", "skills"),
    path.join("C:/work", ".claude", "skills"),
    path.join("C:/data", "skills"),
  ]);
  assert.equal(dirs[dirs.length - 1], path.join("C:/home", ".agents", "skills"), "the user-level agents dir comes last");
});
