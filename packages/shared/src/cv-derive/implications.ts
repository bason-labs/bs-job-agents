// The implication table (CV auto-extend §5.3): well-known "skill B follows from tool A" relations
// that a recruiter would not question (Kubernetes from EKS, Redux from React), applied by code
// before any LLM call, plus the learned entries in data/skill-implications.json (a model-judged
// implication that passed the screen is allowed next time; an undone or deleted derived skill is
// denied for good). Pure, no I/O: the orchestrator reads and writes the JSON file.
import { z } from "zod";
import { lower } from "../truth/claims.js";
import type { Fact } from "../domain/master-cv.js";

export const SKILL_CATEGORIES = ["frontend", "backend", "cloud_devops", "data", "mobile", "testing", "ai_ml"] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** A technology the table knows: its name, other spellings and its categories (none = any). */
export interface KnownTerm {
  name: string;
  variants?: readonly string[];
  categories?: readonly SkillCategory[];
  /** Matched only as written ("Swift" the language, not "SWIFT" the payment network). */
  caseSensitive?: boolean;
  /** A name that is not a tool ("American Express"): known only so its words are not read as one. */
  notATool?: boolean;
}

const FE: SkillCategory[] = ["frontend"];
const BE: SkillCategory[] = ["backend"];
const OPS: SkillCategory[] = ["cloud_devops"];
const DATA: SkillCategory[] = ["data"];
const MOB: SkillCategory[] = ["mobile"];
const TEST: SkillCategory[] = ["testing"];
const AI: SkillCategory[] = ["ai_ml"];
const WEB: SkillCategory[] = ["frontend", "backend"];

/** The term-to-category map (§5.3): the screen rejects "Kubernetes implied from Java" with it. */
export const KNOWN_TERMS: readonly KnownTerm[] = [
  // frontend
  { name: "React", variants: ["ReactJS", "React.js"], categories: FE },
  { name: "React Native", categories: MOB },
  { name: "Next.js", variants: ["NextJS"], categories: WEB },
  { name: "Vue", variants: ["Vue.js", "VueJS"], categories: FE },
  { name: "Nuxt", variants: ["Nuxt.js", "NuxtJS"], categories: WEB },
  { name: "Angular", categories: FE },
  { name: "AngularJS", categories: FE },
  { name: "Svelte", variants: ["SvelteKit"], categories: FE },
  { name: "Redux", variants: ["Redux Toolkit", "RTK"], categories: FE },
  { name: "jQuery", categories: FE },
  { name: "HTML", variants: ["HTML5"], categories: FE },
  { name: "CSS", variants: ["CSS3"], categories: FE },
  { name: "Sass", variants: ["SCSS"], categories: FE },
  { name: "Tailwind", variants: ["Tailwind CSS", "TailwindCSS"], categories: FE },
  { name: "JavaScript", variants: ["JS", "ES6", "ECMAScript"], categories: WEB },
  { name: "TypeScript", variants: ["TS"], categories: WEB },
  { name: "GraphQL", categories: WEB },
  { name: "Apollo", variants: ["Apollo Client", "Apollo Server"], categories: WEB },
  // backend
  { name: "Node.js", variants: ["NodeJS"], categories: BE },
  { name: "Express", variants: ["Express.js", "ExpressJS"], categories: BE },
  // Names whose words are also tools: the longest match takes them first.
  { name: "American Express", variants: ["Amex"], notATool: true },
  { name: "Oracle Corporation", notATool: true },
  { name: "SWIFT network", variants: ["SWIFT payments", "SWIFT messages"], notATool: true },
  { name: "NestJS", variants: ["Nest.js"], categories: BE },
  { name: "Java", categories: BE },
  { name: "Spring Boot", variants: ["Spring Framework"], categories: BE },
  { name: "Python", categories: ["backend", "data", "ai_ml"] },
  { name: "Django", categories: BE },
  { name: "Django REST Framework", variants: ["Django REST", "DRF"], categories: BE },
  { name: "Flask", categories: BE },
  { name: "FastAPI", categories: BE },
  { name: "Golang", categories: BE },
  { name: "Ruby on Rails", variants: ["Rails"], categories: BE },
  { name: "PHP", categories: BE },
  { name: "Laravel", categories: BE },
  { name: ".NET", variants: ["ASP.NET", "dotnet"], categories: BE },
  { name: "C#", categories: BE },
  { name: "REST APIs", variants: ["REST", "RESTful", "REST API", "RESTful APIs", "RESTful API"], categories: BE },
  { name: "Microservices", categories: BE },
  // cloud and DevOps
  { name: "Docker", categories: OPS },
  { name: "Containerization", variants: ["containers", "containerisation"], categories: OPS },
  { name: "Kubernetes", variants: ["K8s"], categories: OPS },
  { name: "Container orchestration", categories: OPS },
  { name: "EKS", variants: ["Amazon EKS", "AWS EKS"], categories: OPS },
  { name: "GKE", categories: OPS },
  { name: "AKS", categories: OPS },
  { name: "OpenShift", categories: OPS },
  { name: "ECS", variants: ["Amazon ECS", "AWS ECS"], categories: OPS },
  { name: "AWS", variants: ["Amazon Web Services"], categories: OPS },
  { name: "EC2", categories: OPS },
  { name: "S3", categories: OPS },
  { name: "Lambda", variants: ["AWS Lambda"], categories: OPS },
  { name: "CloudFormation", categories: OPS },
  { name: "AWS CDK", categories: OPS },
  { name: "GCP", variants: ["Google Cloud", "Google Cloud Platform"], categories: OPS },
  { name: "Cloud Run", categories: OPS },
  { name: "Azure", variants: ["Microsoft Azure"], categories: OPS },
  { name: "Terraform", categories: OPS },
  { name: "Pulumi", categories: OPS },
  { name: "Infrastructure as Code", variants: ["IaC"], categories: OPS },
  { name: "CI/CD", variants: ["CI / CD", "CI-CD", "continuous integration", "continuous delivery", "continuous deployment"], categories: OPS },
  { name: "GitHub Actions", categories: OPS },
  { name: "GitLab CI", variants: ["GitLab CI/CD"], categories: OPS },
  { name: "Jenkins", categories: OPS },
  { name: "CircleCI", categories: OPS },
  { name: "Azure Pipelines", categories: OPS },
  { name: "Bitbucket Pipelines", categories: OPS },
  { name: "Travis CI", categories: OPS },
  { name: "Git" },
  { name: "GitHub" },
  { name: "GitLab" },
  { name: "Bitbucket" },
  // data
  { name: "SQL", variants: ["relational databases", "RDBMS"], categories: ["data", "backend"] },
  { name: "PostgreSQL", variants: ["Postgres"], categories: ["data", "backend"] },
  { name: "MySQL", categories: ["data", "backend"] },
  { name: "MariaDB", categories: ["data", "backend"] },
  { name: "SQL Server", variants: ["MSSQL"], categories: ["data", "backend"] },
  { name: "Oracle Database", variants: ["Oracle DB", "Oracle SQL", "PL/SQL"], categories: ["data", "backend"] },
  { name: "SQLite", categories: ["data", "backend"] },
  { name: "NoSQL", categories: ["data", "backend"] },
  { name: "MongoDB", categories: ["data", "backend"] },
  { name: "DynamoDB", categories: ["data", "backend"] },
  { name: "Redis", categories: ["data", "backend"] },
  { name: "Cassandra", categories: ["data", "backend"] },
  { name: "BigQuery", categories: DATA },
  { name: "Spark", variants: ["Apache Spark", "PySpark"], categories: DATA },
  // mobile
  { name: "Mobile development", variants: ["mobile apps", "mobile app development"], categories: MOB },
  { name: "Flutter", categories: MOB },
  { name: "Swift", variants: ["SwiftUI"], categories: MOB, caseSensitive: true },
  { name: "Kotlin", categories: ["mobile", "backend"] },
  { name: "iOS", categories: MOB },
  { name: "Android", categories: MOB },
  // testing
  { name: "Unit testing", variants: ["unit tests", "automated testing", "automated tests"], categories: TEST },
  { name: "E2E testing", variants: ["end-to-end testing", "end-to-end tests", "E2E tests"], categories: TEST },
  { name: "Jest", categories: TEST },
  { name: "Vitest", categories: TEST },
  { name: "Mocha", categories: TEST },
  { name: "JUnit", categories: TEST },
  { name: "pytest", categories: TEST },
  { name: "Playwright", categories: TEST },
  { name: "Cypress", categories: TEST },
  { name: "Selenium", categories: TEST },
  // AI and ML
  { name: "Machine learning", variants: ["ML"], categories: AI },
  { name: "TensorFlow", categories: AI },
  { name: "PyTorch", categories: AI },
  { name: "scikit-learn", variants: ["sklearn"], categories: AI },
  { name: "LLMs", variants: ["LLM", "large language models"], categories: AI },
  { name: "LangChain", categories: AI },
  { name: "LlamaIndex", categories: AI },
  { name: "OpenAI API", categories: AI },
];

/** One implication: `skill` follows from any of `impliedBy` (names of KNOWN_TERMS). */
export interface Implication {
  skill: string;
  impliedBy: readonly string[];
  /**
   * is_a: each impliedBy term is a kind of `skill` (EKS is Kubernetes, GitHub Actions is CI/CD), so a
   * line about the fact may name it. related: commonly used with it (Redux with React): a skill
   * fact only, never a claim of use in an experience line. Unsure → related.
   */
  kind: "is_a" | "related";
  /** Shown on the Master CV screen ("Why"). */
  rationale: string;
}

/** The seed (§5.3, §10): small and obvious; each one a relation a recruiter would not question. */
export const SEED_IMPLICATIONS: readonly Implication[] = [
  { skill: "Kubernetes", impliedBy: ["EKS", "GKE", "AKS", "OpenShift"], kind: "is_a", rationale: "EKS, GKE, AKS and OpenShift are managed Kubernetes." },
  { skill: "Container orchestration", impliedBy: ["Kubernetes", "EKS", "GKE", "AKS", "OpenShift"], kind: "is_a", rationale: "Kubernetes and its managed services orchestrate containers." },
  { skill: "Containerization", impliedBy: ["Docker", "Kubernetes", "EKS", "GKE", "AKS", "ECS", "OpenShift"], kind: "is_a", rationale: "Docker and Kubernetes services run containers." },
  { skill: "Redux", impliedBy: ["React", "Next.js"], kind: "related", rationale: "Redux is the common state library for React and Next.js apps." },
  { skill: "React", impliedBy: ["Next.js", "React Native"], kind: "related", rationale: "Next.js and React Native are built on React." },
  { skill: "Vue", impliedBy: ["Nuxt"], kind: "related", rationale: "Nuxt is built on Vue." },
  {
    skill: "JavaScript",
    impliedBy: ["TypeScript", "React", "Vue", "Angular", "AngularJS", "Node.js", "Next.js", "Nuxt", "Express", "NestJS", "jQuery", "Svelte"],
    kind: "related", rationale: "These are JavaScript languages, libraries or runtimes.",
  },
  { skill: "HTML", impliedBy: ["React", "Vue", "Angular", "AngularJS", "Next.js", "Nuxt", "Svelte"], kind: "related", rationale: "Web UI frameworks render HTML." },
  { skill: "CSS", impliedBy: ["React", "Vue", "Angular", "AngularJS", "Next.js", "Nuxt", "Svelte", "Tailwind", "Sass"], kind: "related", rationale: "Web UI work styles pages with CSS." },
  { skill: "Node.js", impliedBy: ["Express", "NestJS"], kind: "related", rationale: "Express and NestJS are Node.js frameworks." },
  { skill: "SQL", impliedBy: ["PostgreSQL", "MySQL", "MariaDB", "SQL Server", "Oracle Database", "SQLite"], kind: "is_a", rationale: "These are SQL databases." },
  { skill: "NoSQL", impliedBy: ["MongoDB", "DynamoDB", "Redis", "Cassandra"], kind: "is_a", rationale: "These are NoSQL databases." },
  {
    skill: "CI/CD",
    impliedBy: ["GitHub Actions", "GitLab CI", "Jenkins", "CircleCI", "Azure Pipelines", "Bitbucket Pipelines", "Travis CI"],
    kind: "is_a", rationale: "These are CI/CD systems.",
  },
  { skill: "REST APIs", impliedBy: ["Spring Boot", "Express", "NestJS", "FastAPI", "Django REST Framework"], kind: "related", rationale: "These frameworks are used to build REST APIs." },
  { skill: "Python", impliedBy: ["Django", "Flask", "FastAPI", "pytest"], kind: "related", rationale: "These are Python frameworks and tools." },
  { skill: "Java", impliedBy: ["Spring Boot", "JUnit"], kind: "related", rationale: "Spring Boot and JUnit are Java frameworks." },
  { skill: "Git", impliedBy: ["GitHub", "GitLab", "Bitbucket"], kind: "related", rationale: "GitHub, GitLab and Bitbucket host Git repositories." },
  { skill: "AWS", impliedBy: ["EKS", "ECS", "EC2", "S3", "Lambda", "DynamoDB", "CloudFormation", "AWS CDK"], kind: "is_a", rationale: "These are AWS services." },
  { skill: "GCP", impliedBy: ["GKE", "BigQuery", "Cloud Run"], kind: "is_a", rationale: "These are Google Cloud services." },
  { skill: "Azure", impliedBy: ["AKS"], kind: "is_a", rationale: "AKS is an Azure service." },
  { skill: "Azure", impliedBy: ["Azure Pipelines"], kind: "related", rationale: "Azure Pipelines is part of Azure DevOps, not the Azure cloud." },
  { skill: "Infrastructure as Code", impliedBy: ["Terraform", "CloudFormation", "Pulumi", "AWS CDK"], kind: "is_a", rationale: "These are infrastructure-as-code tools." },
  { skill: "Unit testing", impliedBy: ["JUnit", "pytest"], kind: "is_a", rationale: "These are unit-test frameworks." },
  { skill: "Unit testing", impliedBy: ["Jest", "Vitest", "Mocha"], kind: "related", rationale: "These runners also run integration and end-to-end tests." },
  { skill: "E2E testing", impliedBy: ["Playwright", "Cypress", "Selenium"], kind: "is_a", rationale: "These are end-to-end test tools." },
  { skill: "GraphQL", impliedBy: ["Apollo"], kind: "related", rationale: "Apollo is a GraphQL client and server." },
  { skill: "Machine learning", impliedBy: ["TensorFlow", "PyTorch", "scikit-learn"], kind: "related", rationale: "These are machine-learning libraries." },
  { skill: "LLMs", impliedBy: ["LangChain", "LlamaIndex", "OpenAI API"], kind: "related", rationale: "These are tools for building on large language models." },
  { skill: "Mobile development", impliedBy: ["React Native", "Flutter", "Swift", "iOS", "Android"], kind: "is_a", rationale: "These are mobile app platforms and frameworks." },
];

// ---------------------------------------------------------------- learned entries (data/skill-implications.json)

export const LearnedImplicationsSchema = z.object({
  /** Model-judged implications that passed the screen: resolved by code next time. */
  allow: z
    .array(z.object({ skill: z.string().min(1), impliedBy: z.string().min(1), firstSeen: z.string(), factId: z.string(), rationale: z.string().nullable().default(null) }))
    .default([]),
  /** Derived skills Ba undid or deleted: never derived again (the gap goes back to a fact request). */
  deny: z.array(z.object({ skill: z.string().min(1), restsOn: z.array(z.string()), at: z.string() })).default([]),
});
export type LearnedImplications = z.infer<typeof LearnedImplicationsSchema>;
export const EMPTY_LEARNED: LearnedImplications = { allow: [], deny: [] };

// ---------------------------------------------------------------- terms

/** Case-folded, whitespace collapsed: how terms and gaps are compared everywhere. */
export const fold = (s: string): string => lower(s).replace(/\s+/g, " ").trim();
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");

/** A whole-word match of `spelling`: "Java" is not in "JavaScript", "JS" not in "Next.js", "C" not in "C#". */
const termRe = (spelling: string, flags: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}.])${escape(spelling)}(?![\\p{L}\\p{N}+#]|\\.[\\p{L}\\p{N}])`, flags);

/** Whether `term` occurs in `text` as a whole word (case-folded). */
export function termIn(term: string, text: string): boolean {
  const t = fold(term);
  if (!t) return false;
  return termRe(t, "u").test(fold(text));
}

/** The table a run uses: the seed plus the learned allow entries. */
export interface ImplicationTable {
  implications: readonly Implication[];
  terms: readonly KnownTerm[];
  denied: ReadonlySet<string>;
}

export function implicationTable(learned: LearnedImplications = EMPTY_LEARNED): ImplicationTable {
  const known = new Set(KNOWN_TERMS.map((t) => fold(t.name)));
  const extra: KnownTerm[] = [];
  for (const a of learned.allow) {
    for (const name of [a.skill, a.impliedBy]) {
      if (!known.has(fold(name))) {
        known.add(fold(name));
        extra.push({ name });
      }
    }
  }
  const learnedImplications = learned.allow.map((a) => ({ skill: canonicalName(a.skill, KNOWN_TERMS) ?? a.skill, impliedBy: [canonicalName(a.impliedBy, KNOWN_TERMS) ?? a.impliedBy], kind: "related" as const, rationale: a.rationale ?? "Learned from an earlier derivation." }));
  return {
    implications: [...SEED_IMPLICATIONS, ...learnedImplications],
    terms: [...KNOWN_TERMS, ...extra],
    denied: new Set(learned.deny.map((d) => fold(canonicalName(d.skill, KNOWN_TERMS) ?? d.skill))),
  };
}

function canonicalName(text: string, terms: readonly KnownTerm[]): string | null {
  const t = fold(text);
  return terms.find((k) => fold(k.name) === t || (k.variants ?? []).some((v) => fold(v) === t))?.name ?? null;
}

/** Every spelling of a known term, longest first (so "SQL Server" wins over "SQL"). */
function spellings(terms: readonly KnownTerm[]): { spelling: string; term: KnownTerm }[] {
  return terms
    .flatMap((t) => [t.name, ...(t.variants ?? [])].map((s) => ({ spelling: t.caseSensitive ? s.normalize("NFC") : fold(s), term: t })))
    .sort((a, b) => b.spelling.length - a.spelling.length);
}

export interface TermSpan {
  name: string;
  start: number;
  end: number;
  notATool: boolean;
}

/**
 * The known terms in a text as spans of `text.normalize("NFC")`, longest match first, so "React
 * Native" is never also "React" and "American Express" never "Express"; in text order.
 */
export function termSpans(text: string, table: Pick<ImplicationTable, "terms"> = { terms: KNOWN_TERMS }): TermSpan[] {
  const orig = text.normalize("NFC");
  const low = orig.toLowerCase();
  const taken: TermSpan[] = [];
  for (const { spelling, term } of spellings(table.terms)) {
    for (const m of (term.caseSensitive ? orig : low).matchAll(termRe(spelling, "gu"))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!taken.some((t) => start < t.end && end > t.start)) taken.push({ name: term.name, start, end, notATool: term.notATool === true });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** The known tools a text names, by canonical name, longest match first, in text order. */
export function termsIn(text: string, table: Pick<ImplicationTable, "terms"> = { terms: KNOWN_TERMS }): string[] {
  return [...new Set(termSpans(text, table).filter((t) => !t.notATool).map((t) => t.name))];
}

/** Categories of the known terms a text names (empty: no known category). */
export function categoriesOf(text: string, table: Pick<ImplicationTable, "terms"> = { terms: KNOWN_TERMS }): Set<SkillCategory> {
  const out = new Set<SkillCategory>();
  for (const name of termsIn(text, table)) for (const c of table.terms.find((t) => t.name === name)?.categories ?? []) out.add(c);
  return out;
}

/** A fact's text with its own organisation blanked out (an employer is never a tool: "Oracle", "SWIFT"). */
function textWithoutOrg(fact: Pick<Fact, "text"> & { org?: string | null }): string {
  const text = fact.text.normalize("NFC");
  const org = fact.org?.trim();
  if (!org) return text;
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(org.normalize("NFC"))}(?![\\p{L}\\p{N}])`, "giu"), (m) => " ".repeat(m.length));
}

/** Where a fact names a term: its text (without its org) and each tag, as longest-match spans. */
function factSpans(fact: Pick<Fact, "text" | "tags"> & { org?: string | null }, table: Pick<ImplicationTable, "terms">): { field: string; span: TermSpan }[] {
  return [textWithoutOrg(fact), ...fact.tags].flatMap((field) => termSpans(field, table).map((span) => ({ field, span })));
}

/** Whether a fact names a tool (any spelling, longest match) in its text or tags; its org never counts. */
export function factNames(fact: Pick<Fact, "text" | "tags"> & { org?: string | null }, name: string, table: Pick<ImplicationTable, "terms"> = { terms: KNOWN_TERMS }): boolean {
  if (!table.terms.some((t) => t.name === name)) return [textWithoutOrg(fact), ...fact.tags].some((field) => termIn(name, field));
  return factSpans(fact, table).some(({ span }) => span.name === name && !span.notATool);
}

/** The first spelling of `name` as written in the fact ("Next.js", "react"): the anchor the screen checks. */
export function spellingIn(fact: Pick<Fact, "text" | "tags"> & { org?: string | null }, name: string, table: Pick<ImplicationTable, "terms">): string | null {
  const hit = factSpans(fact, table).find(({ span }) => span.name === name && !span.notATool);
  return hit ? hit.field.normalize("NFC").slice(hit.span.start, hit.span.end) : null;
}

// ---------------------------------------------------------------- gaps

/** A gap no master fact can answer with a skill (a degree, a language, a soft skill): never sent to the model. */
const NOT_DERIVABLE = /\b(degree|bachelor|master'?s|phd|diploma|english|vietnamese|japanese|fluent|fluency|communication|team ?player|onsite|on-site|relocat\w*|visa|years? of (?:professional )?experience|leadership|soft skills?|attitude|passion)\b/i;

export interface GapAnalysis {
  gap: string;
  /** Known terms the gap names. */
  terms: string[];
  /** Terms no active fact names yet. */
  uncovered: string[];
  /** Covered by an active fact (Ba's or derived): nothing to do. */
  covered: boolean;
  /** Every uncovered term was denied (Ba undid or deleted it): left to a fact request. */
  denied: boolean;
  /** Nothing a fact could answer (a degree, a language): left to tailor's fact request, never sent to the model. */
  notDerivable: boolean;
}

/**
 * §5.4 steps 3–4: a gap is covered when every known term it names is in some active fact (a gap
 * naming none: when a fact contains the gap's words); terms Ba undid or deleted are dropped.
 */
export function analyseGap(gap: string, facts: readonly Pick<Fact, "text" | "tags">[], table: ImplicationTable): GapAnalysis {
  const terms = termsIn(gap, table);
  const named = (name: string) => facts.some((f) => factNames(f, name, table));
  if (terms.length === 0) {
    const covered = facts.some((f) => termIn(gap, f.text) || f.tags.some((t) => fold(t) === fold(gap)));
    const denied = table.denied.has(fold(gap));
    return { gap, terms, uncovered: [], covered, denied, notDerivable: !covered && !denied && NOT_DERIVABLE.test(gap) };
  }
  const uncovered = terms.filter((t) => !named(t));
  const open = uncovered.filter((t) => !table.denied.has(fold(t)));
  return { gap, terms, uncovered: open, covered: uncovered.length === 0, denied: uncovered.length > 0 && open.length === 0, notDerivable: false };
}

/** A table derivation: `skill` for `gap`, implied by `facts` (each naming `fromTerms`). */
export interface TableDerivation {
  gap: string;
  implication: Implication;
  facts: { factId: string; fromTerm: string }[];
}

/** Facts cited by one table derivation, at most this many (the rest add nothing). */
export const TABLE_MAX_CITED = 3;

/**
 * §5.4 step 5, no LLM: for each uncovered term of a gap that the table knows, Ba's facts whose text
 * or tags name one of its `impliedBy` terms (word boundary, case-folded). Returns the derivations
 * and the gaps that still have an uncovered term the table could not resolve.
 */
export function tablePass(
  gaps: readonly GapAnalysis[],
  ownFacts: readonly Pick<Fact, "id" | "text" | "tags">[],
  table: ImplicationTable,
): { derivations: TableDerivation[]; remaining: GapAnalysis[] } {
  const derivations: TableDerivation[] = [];
  const remaining: GapAnalysis[] = [];
  const done = new Set<string>();
  for (const g of gaps) {
    let open = g.terms.length === 0;
    for (const term of g.uncovered) {
      if (done.has(term)) continue;
      // A skill can have several entries (is_a and related, seed and learned): use the first that
      // one of Ba's facts supports.
      let implication: Implication | undefined;
      let facts: { factId: string; fromTerm: string }[] = [];
      for (const candidate of table.implications.filter((i) => fold(i.skill) === fold(term))) {
        facts = ownFacts
          .map((f) => {
            const by = candidate.impliedBy.find((name) => factNames(f, name, table));
            const fromTerm = by ? spellingIn(f, by, table) : null;
            return fromTerm ? { factId: f.id, fromTerm } : null;
          })
          .filter((x): x is { factId: string; fromTerm: string } => x !== null)
          .slice(0, TABLE_MAX_CITED);
        if (facts.length > 0) {
          implication = candidate;
          break;
        }
      }
      if (implication && facts.length > 0) {
        derivations.push({ gap: g.gap, implication, facts });
        done.add(term);
      } else open = true;
    }
    if (open) remaining.push({ ...g, uncovered: g.uncovered.filter((t) => !done.has(t)) });
  }
  return { derivations, remaining };
}
