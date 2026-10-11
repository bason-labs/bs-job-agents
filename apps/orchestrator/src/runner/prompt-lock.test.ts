// PM2 S6: bots/prompt-versions.json locks each bot's promptVersion to its ROLE.md SHA-256, so a
// ROLE.md change without a promptVersion bump fails CI here, long before start-up refuses it on
// Ba's machine (decision 8).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rolePromptHash } from "./bots.js";
import { defaultBotsDir } from "./config.js";
import { PROMPT_LOCK_FILE, PromptLockError, checkPromptLock, currentPromptVersions, readPromptLock, updatePromptLock } from "./prompt-lock.js";

const BOTS = defaultBotsDir();
const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of bots/ (bot.json, ROLE.md and the lock) to change freely. */
function botsCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "bsja-lock-"));
  temps.push(root);
  const dir = join(root, "bots");
  cpSync(BOTS, dir, { recursive: true });
  return dir;
}

const bump = (dir: string, bot: string, to: number) => {
  const path = join(dir, bot, "bot.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), promptVersion: to }, null, 2));
};

describe("prompt-version lock (PM2 S6)", () => {
  it("the committed bots/prompt-versions.json matches every bot.json promptVersion and ROLE.md: bump promptVersion with each ROLE.md change, then run bots:lock", () => {
    expect(checkPromptLock(BOTS)).toEqual([]);
    const lock = readPromptLock(BOTS)!;
    expect(Object.keys(lock).sort()).toEqual(["apply", "cv", "lead", "qa", "research"]);
    expect(lock.qa).toEqual({ promptVersion: expect.any(Number), roleMdSha256: rolePromptHash(readFileSync(join(BOTS, "qa", "ROLE.md"), "utf8")) });
  });

  it("a ROLE.md change without a promptVersion bump fails the check, and the lock writer refuses it", () => {
    const dir = botsCopy();
    writeFileSync(join(dir, "qa", "ROLE.md"), `${readFileSync(join(dir, "qa", "ROLE.md"), "utf8")}\nA stricter rule.\n`);
    expect(checkPromptLock(dir)).toEqual([expect.stringMatching(/^bots\/qa\/ROLE\.md changed without a promptVersion bump: bump promptVersion in bots\/qa\/bot\.json/)]);
    expect(() => updatePromptLock(dir)).toThrow(PromptLockError);
    expect(() => updatePromptLock(dir)).toThrow(/qa/);
    // Nothing was written.
    expect(readPromptLock(dir)).toEqual(readPromptLock(BOTS));
  });

  it("a bump with the new ROLE.md passes once the lock is updated", () => {
    const dir = botsCopy();
    const before = readPromptLock(dir)!.qa!.promptVersion;
    writeFileSync(join(dir, "qa", "ROLE.md"), "You are QA, a stricter one.\n");
    bump(dir, "qa", before + 1);
    expect(checkPromptLock(dir)).toEqual([expect.stringMatching(/^bots\/qa: promptVersion is .* but the lock says .*run .*bots:lock/)]);
    expect(updatePromptLock(dir)).toEqual(["qa"]);
    expect(checkPromptLock(dir)).toEqual([]);
    expect(readPromptLock(dir)!.qa).toEqual({ promptVersion: before + 1, roleMdSha256: rolePromptHash("You are QA, a stricter one.\n") });
    expect(updatePromptLock(dir)).toEqual([]);
  });

  it("a missing lock, a bot missing from it, a removed bot and a version that went down are all reported", () => {
    const dir = botsCopy();
    rmSync(join(dir, PROMPT_LOCK_FILE));
    expect(checkPromptLock(dir)).toEqual([expect.stringMatching(/prompt-versions\.json is missing/)]);

    const full = currentPromptVersions(BOTS);
    const { research: _r, ...withoutResearch } = full;
    writeFileSync(join(dir, PROMPT_LOCK_FILE), JSON.stringify({ ...withoutResearch, scout: { promptVersion: 1, roleMdSha256: "0".repeat(64) } }));
    expect(checkPromptLock(dir).sort()).toEqual([
      expect.stringMatching(/^bots\/research: not in bots\/prompt-versions\.json/),
      expect.stringMatching(/^bots\/scout: in bots\/prompt-versions\.json but the bot is gone/),
    ]);

    writeFileSync(join(dir, PROMPT_LOCK_FILE), JSON.stringify({ ...full, cv: { ...full.cv!, promptVersion: full.cv!.promptVersion + 3 } }));
    expect(checkPromptLock(dir)).toEqual([expect.stringMatching(/^bots\/cv: promptVersion went down/)]);
    expect(() => updatePromptLock(dir)).toThrow(/went down/);
  });
});
