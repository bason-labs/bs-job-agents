// Rule 3 (spec §3, PM S22): Lead's propose_workflow suggestions. Lead only proposes; Ba decides.
// - Proposals are kept in data/workflow-proposals.json (one process holds the data folder lock;
//   writes go through a temp file and a rename, so a crash never leaves half a file).
// - Approving saves the workflow as a new row/version in the `workflows` table and starts nothing.
// - A proposal can never replace a shipped workflow (workflows/*.yaml or the Phase 1 names): a
//   newer table version of job-scan would otherwise become the definition every scan runs.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProposeWorkflowInputSchema,
  WORKFLOW_NAMES,
  WORKFLOW_PARAMS_SCHEMAS,
  WorkflowProposalSchema,
  type WorkflowDefinition,
  type WorkflowProposal,
} from "@bs-job-agents/shared";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { getWorkflow, saveWorkflow, type Db } from "../db/index.js";
import type { WorkflowSource } from "../engine/index.js";
import { WorkflowLoadError, parseWorkflowYaml } from "./boot/workflows.js";
import { ApiHttpError, badRequest, conflict, notFound, zodMessage } from "./errors.js";

export const PROPOSALS_FILE = "workflow-proposals.json";
/** Pending proposals kept at most; a Lead that keeps proposing is refused past this. */
export const MAX_PENDING_PROPOSALS = 50;

const FileSchema = z.object({ proposals: z.array(WorkflowProposalSchema) });

export interface ProposalStoreOptions {
  dataDir: string;
  now: () => Date;
  /** The shipped workflows (files): their names can never be proposed. */
  workflows: () => WorkflowSource | null;
}

export class ProposalStore {
  private readonly path: string;

  constructor(private readonly opts: ProposalStoreOptions) {
    this.path = join(opts.dataDir, PROPOSALS_FILE);
  }

  list(): WorkflowProposal[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = FileSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      return parsed.success ? parsed.data.proposals : [];
    } catch {
      return [];
    }
  }

  get(id: string): WorkflowProposal | undefined {
    return this.list().find((p) => p.id === id);
  }

  private save(proposals: WorkflowProposal[]): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ proposals }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private isShipped(name: string): boolean {
    if ((WORKFLOW_NAMES as readonly string[]).includes(name)) return true;
    const source = this.opts.workflows();
    const files = source && "list" in source && typeof source.list === "function" ? (source.list() as WorkflowDefinition[]) : [];
    return files.some((d) => d.name === name);
  }

  /** propose_workflow: validate and keep a suggestion for Ba (rule 3). Throws ApiHttpError. */
  propose(raw: unknown, meta: { taskId: number | null }): WorkflowProposal {
    const parsed = ProposeWorkflowInputSchema.safeParse(raw);
    if (!parsed.success) throw badRequest(`propose_workflow: ${zodMessage(parsed.error)}`, parsed.error.issues);
    const input = parsed.data;
    if (this.isShipped(input.name)) throw conflict(`${input.name} is a shipped workflow; propose it under a new name`);
    if (input.basedOn !== null) {
      const params = WORKFLOW_PARAMS_SCHEMAS[input.basedOn].safeParse(input.params ?? {});
      if (!params.success) throw badRequest(`propose_workflow: params for ${input.basedOn}: ${zodMessage(params.error)}`, params.error.issues);
    } else {
      const def = this.parseDefinition(input.definitionYaml!, input.name);
      if (def.steps.length === 0) throw badRequest("propose_workflow: the definition has no steps");
    }
    const proposals = this.list();
    if (proposals.filter((p) => p.status === "pending").length >= MAX_PENDING_PROPOSALS) {
      throw conflict(`there are already ${MAX_PENDING_PROPOSALS} proposals waiting for Ba`);
    }
    const proposal: WorkflowProposal = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      basedOn: input.basedOn,
      params: input.params,
      definitionYaml: input.definitionYaml,
      status: "pending",
      taskId: meta.taskId === null ? null : String(meta.taskId),
      proposedAt: this.opts.now().toISOString(),
      decidedAt: null,
      savedVersion: null,
    };
    this.save([...proposals, proposal]);
    return proposal;
  }

  private parseDefinition(yaml: string, name: string): WorkflowDefinition {
    let def: WorkflowDefinition;
    try {
      def = parseWorkflowYaml(yaml, `proposal ${name}`);
    } catch (err) {
      throw badRequest(err instanceof WorkflowLoadError ? err.message : `the proposed definition is invalid`);
    }
    if (def.name !== name) throw badRequest(`the proposed definition is named ${def.name}, not ${name}`);
    return def;
  }

  private pending(id: string): { all: WorkflowProposal[]; proposal: WorkflowProposal } {
    const all = this.list();
    const proposal = all.find((p) => p.id === id);
    if (!proposal) throw notFound(`workflow proposal ${id} not found`);
    if (proposal.status !== "pending") throw conflict(`workflow proposal ${id} was already ${proposal.status}`);
    return { all, proposal };
  }

  /** Ba approves: saved as the next version in the `workflows` table. Nothing is started. */
  approve(id: string, db: Db): { proposal: WorkflowProposal; workflow: { name: string; version: number } } {
    const { all, proposal } = this.pending(id);
    if (this.isShipped(proposal.name)) throw conflict(`${proposal.name} is a shipped workflow; it cannot be replaced from chat`);
    const source = this.opts.workflows();
    const version = (getWorkflow(db, proposal.name)?.version ?? 0) + 1;
    let def: WorkflowDefinition;
    let header = `# Proposed by Lead (rule 3) and approved by Ba on ${this.opts.now().toISOString()}.\n`;
    if (proposal.basedOn !== null) {
      const base = source?.get(proposal.basedOn);
      if (!base) throw new ApiHttpError(503, "internal", `the ${proposal.basedOn} workflow is not loaded`);
      def = { ...base, name: proposal.name, version, description: proposal.description };
      header += `# Based on ${proposal.basedOn} v${base.version}; preset params: ${JSON.stringify(proposal.params ?? {})}\n`;
    } else {
      def = { ...this.parseDefinition(proposal.definitionYaml!, proposal.name), version };
    }
    const yaml = header + stringifyYaml(def);
    // The saved text must load like a file would (S4 checks).
    parseWorkflowYaml(yaml, `${proposal.name} v${version}`);
    saveWorkflow(db, { name: proposal.name, version, definitionYaml: yaml }, { now: this.opts.now() });
    const decided: WorkflowProposal = { ...proposal, status: "approved", decidedAt: this.opts.now().toISOString(), savedVersion: version };
    this.save(all.map((p) => (p.id === id ? decided : p)));
    return { proposal: decided, workflow: { name: proposal.name, version } };
  }

  dismiss(id: string): WorkflowProposal {
    const { all, proposal } = this.pending(id);
    const decided: WorkflowProposal = { ...proposal, status: "dismissed", decidedAt: this.opts.now().toISOString() };
    this.save(all.map((p) => (p.id === id ? decided : p)));
    return decided;
  }
}
