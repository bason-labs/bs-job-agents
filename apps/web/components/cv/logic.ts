// Master CV editor logic (UC-20, §6.1). Only Ba edits these facts; every CV bullet cites them.
import { FactTypeSchema, MasterCvSchema, type Fact, type FactType, type MasterCv } from "@bs-job-agents/shared";

const TYPE_LABELS: Record<FactType, string> = {
  experience: "Experience",
  project: "Project",
  skill: "Skill",
  education: "Education",
  metric: "Metric",
};
export const FACT_TYPE_OPTIONS = FactTypeSchema.options.map((value) => ({ value, label: TYPE_LABELS[value] }));

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * A free id for a new fact: the prefix other facts of the same organisation use (grad-, aeg-),
 * else the organisation's first word (4 letters) or, without one, the type (skill-).
 */
export function suggestFactId(facts: readonly Fact[], { org, type }: { org: string | null; type: FactType }): string {
  const o = org?.trim() ?? "";
  const sibling = o ? facts.find((f) => f.org?.trim().toLowerCase() === o.toLowerCase()) : undefined;
  const prefix = sibling ? sibling.id.replace(/-\d+$/, "") : o ? (slug(o).split(" ")[0] ?? type).slice(0, 4) || type : type;
  const used = facts
    .map((f) => new RegExp(`^${prefix}-(\\d+)$`).exec(f.id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return `${prefix}-${used.length ? Math.max(...used) + 1 : 1}`;
}

export function newFact(facts: readonly Fact[], over: Partial<Fact> = {}): Fact {
  const type = over.type ?? "skill";
  const org = over.org ?? null;
  return { id: suggestFactId(facts, { org, type }), type, text: "", textVi: null, tags: [], org, dates: null, ...over };
}

/** "Add a fact" from CV's question (§6.1 missing facts, factRequests). */
export function factFromRequest(facts: readonly Fact[], request: { topic: string }): Fact {
  return newFact(facts, { type: "skill", text: `${request.topic} — `, tags: [request.topic.toLowerCase()] });
}

/** "Gradion · experience · Sep 2025 – present" (prototype: org · type). */
export function factMeta(fact: Fact): string {
  return [fact.org ?? "—", fact.type, fact.dates].filter(Boolean).join(" · ");
}

export interface MasterCvErrors {
  /** By fact index. */
  facts: Record<number, string>;
  contact: Partial<Record<"name" | "email", string>>;
}

/** The shared schema's rules plus "text can't be blank", one message per fact. */
export function validateMasterCv(cv: MasterCv): MasterCvErrors {
  const errors: MasterCvErrors = { facts: {}, contact: {} };
  const result = MasterCvSchema.safeParse(cv);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const [head, index, field] = issue.path;
      if (head === "facts" && typeof index === "number" && errors.facts[index] === undefined) {
        errors.facts[index] = field === "text" ? "Write the fact's text" : issue.message;
      }
      if (head === "contact" && (index === "name" || index === "email") && !errors.contact[index]) {
        errors.contact[index] = index === "name" ? "Your name is required" : "Enter a valid email";
      }
    }
  }
  cv.facts.forEach((f, i) => {
    if (!f.text.trim() && errors.facts[i] === undefined) errors.facts[i] = "Write the fact's text";
  });
  return errors;
}

export const hasErrors = (e: MasterCvErrors) => Object.keys(e.facts).length > 0 || Object.keys(e.contact).length > 0;

export function isMasterDirty(draft: MasterCv, saved: MasterCv): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}
