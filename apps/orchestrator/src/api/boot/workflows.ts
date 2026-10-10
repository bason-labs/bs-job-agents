// workflows/*.yaml (spec §7, PM S22): parsed with `yaml`, validated with the shared
// WorkflowDefinitionSchema (step references, and the S4 task-kind checks: a kind must be its bot's,
// apply.submit only in an action step), and served to the engine as a versioned WorkflowSource.
// - A file is `<name>.yaml` or `<name>.v<version>.yaml`, so a copy-paste names itself.
// - With a database, each version is stored once in the `workflows` table (rule 3: named,
//   versioned definitions). A file whose definition changed while its version stayed the same is
//   refused (as a ROLE.md without a promptVersion bump), so a run's version always means one thing.
// - get(name, version) also serves an older version a run started with from the table after the
//   YAML moved on; get(name) is the newest version in the files or the table (W3a part 2 stores the
//   workflows Ba approves from Lead's propose_workflow there).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "@bs-job-agents/shared";
import { parse as parseYaml } from "yaml";
import { getWorkflow, saveWorkflow, type Db } from "../../db/index.js";
import type { WorkflowSource } from "../../engine/index.js";
import { zodMessage } from "../errors.js";

export class WorkflowLoadError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`workflows/${file}: ${detail}`);
    this.name = "WorkflowLoadError";
  }
}

export interface LoadedWorkflow {
  file: string;
  def: WorkflowDefinition;
  /** The file's text, stored as `definition_yaml`. */
  yaml: string;
}

/** Parse and validate YAML text as a workflow definition; `file` names it in errors. */
export function parseWorkflowYaml(text: string, file: string): WorkflowDefinition {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new WorkflowLoadError(file, `not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new WorkflowLoadError(file, zodMessage(parsed.error));
  return parsed.data;
}

/** Every *.yaml / *.yml in `dir`, validated, in file-name order. */
export function loadWorkflowFiles(dir: string): LoadedWorkflow[] {
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  const seen = new Map<string, string>();
  return files.map((file) => {
    const yaml = readFileSync(join(dir, file), "utf8");
    const def = parseWorkflowYaml(yaml, file);
    const stem = file.replace(/\.ya?ml$/, "");
    if (stem !== def.name && stem !== `${def.name}.v${def.version}`) {
      throw new WorkflowLoadError(file, `defines ${def.name} v${def.version}; name the file ${def.name}.yaml or ${def.name}.v${def.version}.yaml`);
    }
    const key = `${def.name}@${def.version}`;
    const other = seen.get(key);
    if (other) throw new WorkflowLoadError(file, `${def.name} v${def.version} is also defined in ${other}`);
    seen.set(key, file);
    return { file, def, yaml };
  });
}

/** Key order does not matter; defaults are applied by the schema on both sides. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** Store each loaded version once; refuse a changed definition under the same version. */
function register(db: Db, loaded: readonly LoadedWorkflow[], now?: () => Date): void {
  db.transaction((tx) => {
    for (const w of loaded) {
      const stored = getWorkflow(tx, w.def.name, w.def.version);
      if (!stored) {
        saveWorkflow(tx, { name: w.def.name, version: w.def.version, definitionYaml: w.yaml }, now ? { now: now() } : undefined);
        continue;
      }
      let before: WorkflowDefinition | null = null;
      try {
        before = parseWorkflowYaml(stored.definitionYaml, `${w.def.name} v${w.def.version} (stored)`);
      } catch {
        before = null;
      }
      if (before === null || canonical(before) !== canonical(w.def)) {
        throw new WorkflowLoadError(
          w.file,
          `${w.file} changed but its version is still ${w.def.version}: bump version in workflows/${w.file} (runs keep the version they started with)`,
        );
      }
    }
  });
}

export interface YamlWorkflowSource extends WorkflowSource {
  /** The definitions loaded from the files. */
  list(): WorkflowDefinition[];
}

export function yamlWorkflowSource(opts: { dir: string; db?: Db | null; now?: () => Date }): YamlWorkflowSource {
  const loaded = loadWorkflowFiles(opts.dir);
  const db = opts.db ?? null;
  if (db) register(db, loaded, opts.now);
  const fromFiles = loaded.map((w) => w.def);
  const fromTable = new Map<string, WorkflowDefinition | null>();

  const stored = (name: string, version: number): WorkflowDefinition | undefined => {
    if (!db) return undefined;
    const key = `${name}@${version}`;
    if (!fromTable.has(key)) {
      const row = getWorkflow(db, name, version);
      let def: WorkflowDefinition | null = null;
      try {
        def = row ? parseWorkflowYaml(row.definitionYaml, `${name} v${version} (stored)`) : null;
      } catch {
        def = null;
      }
      fromTable.set(key, def);
    }
    return fromTable.get(key) ?? undefined;
  };

  const newestStored = (name: string): number => {
    if (!db) return 0;
    return getWorkflow(db, name)?.version ?? 0;
  };

  return {
    list: () => [...fromFiles],
    get(name, version) {
      const files = fromFiles.filter((d) => d.name === name);
      if (version !== undefined) return files.find((d) => d.version === version) ?? stored(name, version);
      const newestFile = files.sort((a, b) => b.version - a.version)[0];
      const tableVersion = newestStored(name);
      if (newestFile && newestFile.version >= tableVersion) return newestFile;
      return tableVersion > 0 ? stored(name, tableVersion) : newestFile;
    },
  };
}
