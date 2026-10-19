// Skill self-repair §5.5 (AD-7, SEC-10): the only writer of source skill files. It can write exactly
// one file per source, <bots>/research/skills/source-<dir>/SKILL.md, and nothing else:
//   - the path is built from the source key (lowercase letters, digits and "_"), never taken from a draft;
//   - every folder on the way (research, skills, source-<dir>) must exist as a real folder, not a
//     symbolic link, and the skill folder's real path must be the expected one;
//   - the skill folder may hold no symbolic link at all, and SKILL.md must be a regular file;
//   - the new text goes to a temporary file in the same folder, then replaces SKILL.md by rename
//     (atomic on one file system); a failure removes the temporary file and leaves SKILL.md as it was.
// It never commits to git and never touches any other file of the bot.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { SkillFiles } from "../../engine/ports.js";

export class SkillStoreRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillStoreRefused";
  }
}

const SOURCE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const BOT = "research";
const FILE = "SKILL.md";

export interface SkillStoreOptions {
  /** Absolute bots/ folder of the repository. */
  botsDir: string;
  /** The repository root, for the paths shown to Ba (default: the parent of botsDir). */
  repoRoot?: string;
}

export class SkillStore implements SkillFiles {
  private readonly botsDir: string;
  private readonly repoRoot: string;

  constructor(opts: SkillStoreOptions) {
    this.botsDir = opts.botsDir;
    this.repoRoot = opts.repoRoot ?? join(opts.botsDir, "..");
  }

  /** The skill file's path relative to the repository, e.g. bots/research/skills/source-topcv/SKILL.md. */
  pathOf(source: string): string {
    return relative(this.repoRoot, this.target(source).file).split(sep).join("/");
  }

  /** The text in force (the same checks as a write). */
  read(source: string): string {
    const { file } = this.checked(source);
    return readFileSync(file, "utf8");
  }

  /** Replace the source's SKILL.md with `text`, atomically. Throws SkillStoreRefused, or the I/O error. */
  write(source: string, text: string): void {
    const { dir, file } = this.checked(source);
    const temp = join(dir, `.${FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    let fd: number | null = null;
    try {
      // "wx": never follows or reuses an existing path.
      fd = openSync(temp, "wx", 0o644);
      writeSync(fd, text);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, file);
    } catch (err) {
      if (fd !== null) closeSync(fd);
      rmSync(temp, { force: true });
      throw err;
    }
  }

  private target(source: string): { dir: string; file: string } {
    if (!SOURCE_KEY.test(source)) throw new SkillStoreRefused(`"${source}" is not a source key`);
    const dir = join(this.botsDir, BOT, "skills", `source-${source.replace(/_/g, "-")}`);
    return { dir, file: join(dir, FILE) };
  }

  private checked(source: string): { dir: string; file: string } {
    const { dir, file } = this.target(source);
    let real: string;
    try {
      // Each folder below bots/ is a real folder, not a link.
      for (const part of [join(this.botsDir, BOT), join(this.botsDir, BOT, "skills"), dir]) {
        const st = lstatSync(part);
        if (st.isSymbolicLink() || !st.isDirectory()) throw new SkillStoreRefused(`${relative(this.repoRoot, part)} is not a folder`);
      }
      real = realpathSync(dir);
    } catch (err) {
      if (err instanceof SkillStoreRefused) throw err;
      throw new SkillStoreRefused(`there is no skill folder for ${source}`);
    }
    if (real !== join(realpathSync(this.botsDir), BOT, "skills", `source-${source.replace(/_/g, "-")}`)) {
      throw new SkillStoreRefused(`the skill folder of ${source} resolves outside bots/${BOT}/skills`);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new SkillStoreRefused(`the skill folder of ${source} holds a symbolic link (${entry.name})`);
    }
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new SkillStoreRefused(`${relative(this.repoRoot, file)} is not a regular file`);
    return { dir, file };
  }
}
