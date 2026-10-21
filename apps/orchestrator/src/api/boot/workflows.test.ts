import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "@bs-job-agents/shared";
import { applyToFileWorkflow, applyToLinkWorkflow, jobScanWorkflow } from "@bs-job-agents/shared/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkflow, openTestDb, saveWorkflow } from "../../db/index.js";
import { createTestEngine } from "../../engine/testing/index.js";
import { findRepoRoot } from "../../config.js";
import { WorkflowLoadError, loadWorkflowFiles, yamlWorkflowSource } from "./workflows.js";

const REPO_WORKFLOWS = join(findRepoRoot(), "workflows");
const temps: string[] = [];
function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bsja-wf-"));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repoYaml = (name: string) => readFileSync(join(REPO_WORKFLOWS, `${name}.yaml`), "utf8");

describe("workflows/*.yaml (S22, spec §7.2–7.3b)", () => {
  it("the three files parse, validate (incl. the S4 task-kind checks) and equal the shared fixtures the engine tests run on", () => {
    const loaded = loadWorkflowFiles(REPO_WORKFLOWS);
    expect(loaded.map((w) => w.def.name).sort()).toEqual(["apply-to-file", "apply-to-link", "job-scan"]);
    const byName = new Map(loaded.map((w) => [w.def.name, w.def]));
    expect(byName.get("job-scan")).toEqual(WorkflowDefinitionSchema.parse(jobScanWorkflow));
    expect(byName.get("apply-to-link")).toEqual(WorkflowDefinitionSchema.parse(applyToLinkWorkflow));
    expect(byName.get("apply-to-file")).toEqual(WorkflowDefinitionSchema.parse(applyToFileWorkflow));
  });

  it("refuses a task kind the bot does not have, and apply.submit outside an action step", () => {
    const typo = repoYaml("job-scan").replace("kind: fit", "kind: fitt");
    expect(() => loadWorkflowFiles(tempDir({ "job-scan.yaml": typo }))).toThrow(/job-scan\.yaml.*"fitt" is not one of research's kinds/s);
    const outward = repoYaml("job-scan").replace("    type: action\n", "    type: task\n").replace("    approvalFrom: review\n", "");
    expect(() => loadWorkflowFiles(tempDir({ "job-scan.yaml": outward }))).toThrow(/apply\.submit is outward-facing/);
  });

  it("names the file of a YAML syntax error, a name that does not match the file, and a duplicate version", () => {
    expect(() => loadWorkflowFiles(tempDir({ "job-scan.yaml": "name: [unclosed" }))).toThrow(WorkflowLoadError);
    expect(() => loadWorkflowFiles(tempDir({ "job-scan.yaml": "name: [unclosed" }))).toThrow(/job-scan\.yaml/);
    expect(() => loadWorkflowFiles(tempDir({ "scan.yaml": repoYaml("job-scan") }))).toThrow(/scan\.yaml.*job-scan/s);
    expect(() => loadWorkflowFiles(tempDir({ "job-scan.yaml": repoYaml("job-scan"), "job-scan.v2.yaml": repoYaml("job-scan") }))).toThrow(/job-scan v2/);
    expect(loadWorkflowFiles(tempDir({ "job-scan.v3.yaml": repoYaml("job-scan").replace("version: 2", "version: 3") }))[0]!.def.version).toBe(3);
  });

  it("get() returns the latest version, or the exact one a run started with", () => {
    const v3 = repoYaml("job-scan").replace("version: 2", "version: 3").replace("take: $profile.maxJobs", "take: 3");
    const source = yamlWorkflowSource({ dir: tempDir({ "job-scan.yaml": repoYaml("job-scan"), "job-scan.v3.yaml": v3 }) });
    expect(source.get("job-scan")?.version).toBe(3);
    expect(source.get("job-scan", 2)?.version).toBe(2);
    expect(source.get("job-scan", 4)).toBeUndefined();
    expect(source.get("nope")).toBeUndefined();
  });
});

describe("versioned WorkflowSource over the workflows table (rule 3)", () => {
  it("stores each version once; the same definition loads again (comments and layout may change)", () => {
    const db = openTestDb();
    const dir = tempDir({ "job-scan.yaml": repoYaml("job-scan") });
    yamlWorkflowSource({ dir, db });
    const stored = getWorkflow(db, "job-scan", 2);
    expect(stored?.definitionYaml).toBe(repoYaml("job-scan"));
    writeFileSync(join(dir, "job-scan.yaml"), `# a new comment\n${repoYaml("job-scan")}`);
    expect(() => yamlWorkflowSource({ dir, db })).not.toThrow();
    expect(getWorkflow(db, "job-scan", 2)?.definitionYaml).toBe(repoYaml("job-scan"));
    db.$client.close();
  });

  it("refuses a definition that changed without a version bump", () => {
    const db = openTestDb();
    const dir = tempDir({ "job-scan.yaml": repoYaml("job-scan") });
    yamlWorkflowSource({ dir, db });
    writeFileSync(join(dir, "job-scan.yaml"), repoYaml("job-scan").replace("maxRounds: 3", "maxRounds: 2"));
    expect(() => yamlWorkflowSource({ dir, db })).toThrow(/job-scan\.yaml changed but its version is still 2: bump version/);
    db.$client.close();
  });

  it("serves an older version a run started with from the table, after the YAML moved on", () => {
    const db = openTestDb();
    const old = WorkflowDefinitionSchema.parse({ ...jobScanWorkflow, version: 1, description: "old" });
    saveWorkflow(db, { name: "job-scan", version: 1, definitionYaml: JSON.stringify(old) });
    // CV auto-extend moved job-scan to version 2 (the derive step): runs started on 1 keep it.
    const source = yamlWorkflowSource({ dir: tempDir({ "job-scan.yaml": repoYaml("job-scan") }), db });
    expect(source.get("job-scan")?.version).toBe(2);
    expect((source.get("job-scan", 1) as WorkflowDefinition).description).toBe("old");
    db.$client.close();
  });

  it("runs job-scan from the YAML on the engine to a review card", async () => {
    const t = await createTestEngine({ start: false });
    const source = yamlWorkflowSource({ dir: REPO_WORKFLOWS, db: t.db });
    t.engine.deps.workflows = source;
    await t.engine.start();
    const run = t.engine.startWorkflow({ workflow: "job-scan", params: { searchProfileId: null, overrides: null } }, { trigger: "chat" });
    await t.idle();
    expect(t.events("review.ready").length).toBe(1);
    expect(t.step(run.id, "review", t.events("review.ready")[0]!.jobId)?.status).toBe("waiting");
    t.engine.stop();
  });
});
