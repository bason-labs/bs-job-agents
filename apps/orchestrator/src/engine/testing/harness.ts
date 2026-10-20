// A whole engine on an in-memory SQLite database with every outside dependency faked: FakeRunner
// for both engines, a manual clock, in-memory files, fake Chrome, Figma, guard hooks and PDF text.
// For the engine's own tests and for later workers' integration tests (W3, W4).
import { APP_EVENT_TYPES, AppEventSchema, type AppEvent, type AppEventType, type BotDefinitionInput, type EventOfType, type SearchSource } from "@bs-job-agents/shared";
import {
  createSearchProfile,
  getStepByKey,
  listEvents,
  listTasks,
  mappers,
  openTestDb,
  type Db,
  type SearchProfile,
  type SearchProfileInput,
  type Step,
  type Task,
} from "../../db/index.js";
import { seedBots, T0 } from "../../db/test-helpers.js";
import { EnginePaths, type EngineConfig } from "../config.js";
import { Engine } from "../engine.js";
import type { ConversationSink } from "../conversations.js";
import type { DerivedFactSink } from "../derive.js";
import type { FactDraftSink } from "../fact-drafts.js";
import type { ScanOutputChecker } from "../scan-check.js";
import type { BoardScanPort, FeedScanPort, GuidanceDeps, MemoryWriter, OrphanKiller, RolePromptSource, SkillFiles } from "../ports.js";
import type { ActionStepOutput, HumanStepOutput } from "../state.js";
import { FakeClock } from "./fake-clock.js";
import { MemoryDerivedFacts } from "./derived-facts.js";
import { FakeRunner } from "./fake-runner.js";
import {
  FakeBrowserProbe,
  FakeFigmaPort,
  FakeGuardHooks,
  FakeMasterCv,
  FakePdfText,
  MemoryFileStore,
  staticBotRegistry,
  staticWorkflowSource,
} from "./fakes.js";

export interface TestEngineOptions {
  /** Search Profile sources (default: itviec only, one job). */
  sources?: SearchSource[];
  profile?: Partial<SearchProfileInput>;
  /** No Search Profile at all. */
  noProfile?: boolean;
  config?: Partial<EngineConfig>;
  bots?: BotDefinitionInput[];
  /** Call engine.start() (default true). */
  start?: boolean;
  /** Use an existing database (e.g. after a simulated crash). */
  db?: Db;
  clock?: FakeClock;
  files?: MemoryFileStore;
  /** UC-18: records the process groups recovery asks to stop. */
  processes?: OrphanKiller;
  /** ROLE.md per bot: start-up records prompt_versions (and refuses a stale version). */
  prompts?: RolePromptSource;
  /** Rule 2 memory writer (default none); start-up seeds through it (PM2 S5). */
  memory?: MemoryWriter;
  /** W3a's chat-flow port (PM2 S2). */
  conversations?: ConversationSink;
  /** Owner request 2026-10-11: the API's fact-draft port. */
  factDrafts?: FactDraftSink;
  /** CV auto-extend: the API's derived-fact port, or "memory" for MemoryDerivedFacts (default none: the derive step does nothing). */
  derivedFacts?: DerivedFactSink | "memory";
  /** PM3 S8: the scan-output checker (default none = accept). */
  scanChecker?: ScanOutputChecker;
  /** W5: feed sources (default none: a feed source's scan fails as not wired). */
  feeds?: FeedScanPort;
  /** API research: boards read through an API (default none: every board in the browser). */
  boards?: BoardScanPort;
  /** CV guidance: the fetcher and seed (default none: no rule set, no refresh, no guidance review). */
  guidance?: GuidanceDeps;
  /** Skill self-repair: the source skill files (default none: no repair starts). */
  skills?: SkillFiles;
}

export interface TestEngine {
  db: Db;
  clock: FakeClock;
  files: MemoryFileStore;
  runner: FakeRunner;
  browser: FakeBrowserProbe;
  figma: FakeFigmaPort;
  guards: FakeGuardHooks;
  masterCv: FakeMasterCv;
  /** The in-memory derived-fact sink (derivedFacts: "memory"), else null. */
  derived: MemoryDerivedFacts | null;
  paths: EnginePaths;
  engine: Engine;
  profile: SearchProfile | null;
  /** Shared events appended so far (optionally of one type). */
  events<T extends AppEventType>(type: T): EventOfType<T>[];
  allEvents(): AppEvent[];
  step(runId: number, key: string, branchKey?: string): Step | undefined;
  /** Tasks of one key ("research.fit"), oldest first. */
  tasks(key?: string): Task[];
  review(runId: number, jobId: number): HumanStepOutput | undefined;
  action(runId: number, jobId: number): ActionStepOutput | undefined;
  /** Wait until nothing runs, then check the event invariants (checkEvents). */
  idle(): Promise<void>;
  /** Let started tasks reach their runner (e.g. before advancing the clock past a FakeRunner delay). */
  flush(): Promise<void>;
  /** Events the engine's subscribers got (SSE), in order. */
  delivered(): AppEvent[];
  /**
   * §10.2 rule 8, §11: every row of a shared event type validates (none is silently dropped
   * from the UI), other rows are known audit-only types, and subscribers got exactly
   * replay(afterId), valid and in id order. Throws on a violation.
   */
  checkEvents(): void;
}

/**
 * For tests that move the clock a day or more (an approval token expiring): the scheduler's 30 s
 * poll would otherwise fire thousands of times inside one FakeClock.advance, which made those
 * tests ~10x slower than the rest and let them hit the test timeout under load. Nothing else
 * changes: the poll still fires, just every 6 hours.
 */
export const LONG_WAIT_CONFIG: Partial<EngineConfig> = { schedulerPollMs: 6 * 3600_000 };

export const DATA_DIR = "/data";
export const BOTS_DIR = "/bots";

/**
 * Rows the engine writes for the audit log only; never streamed (UC-18: the spawned CLI's pid;
 * PM2 S4: a CV spawn's protected-pages hash; PM2 S1: a once-only Lead message was posted).
 */
export const AUDIT_ONLY_EVENT_TYPES = ["runner.spawned", "figma.before", "lead.notice", "fact_draft.rejected", "derive.rejected", "chrome.browsers_seen", "settings.chrome_browser"] as const;

export async function createTestEngine(opts: TestEngineOptions = {}): Promise<TestEngine> {
  const fresh = opts.db === undefined;
  const db = opts.db ?? openTestDb();
  if (fresh) seedBots(db);
  const clock = opts.clock ?? new FakeClock(T0);
  const files = opts.files ?? new MemoryFileStore();
  const runner = new FakeRunner({ clock, screenshots: files });
  const browser = new FakeBrowserProbe();
  const figma = new FakeFigmaPort(files);
  const guards = new FakeGuardHooks(files);
  const masterCv = new FakeMasterCv(`${DATA_DIR}/master-cv.yaml`, files);
  const derived = opts.derivedFacts === "memory" ? new MemoryDerivedFacts(files, masterCv) : null;
  const derivedFacts = opts.derivedFacts === "memory" ? derived! : opts.derivedFacts;
  const paths = new EnginePaths(DATA_DIR, BOTS_DIR);
  const profile =
    !fresh || opts.noProfile
      ? null
      : createSearchProfile(
          db,
          {
            roles: ["Frontend Engineer"],
            locations: ["Ho Chi Minh City"],
            sources: opts.sources ?? ["itviec"],
            ...opts.profile,
          },
          { now: clock.now() },
        );
  // The bus delivers what is appended after it was built (EventBus tails the table from here).
  const startId = listEvents(db).at(-1)?.id ?? 0;
  const engine = new Engine({
    db,
    runners: { claude: runner, codex: runner },
    bots: staticBotRegistry(opts.bots),
    workflows: staticWorkflowSource(),
    paths,
    files,
    browser,
    figma,
    guards,
    pdf: new FakePdfText(),
    masterCv,
    clock,
    // §12's dry-run gate is on in production; tests opt in (dry-run-gate.test.ts).
    config: { requireDryRunFirst: false, ...opts.config },
    ...(opts.processes ? { processes: opts.processes } : {}),
    ...(opts.prompts ? { prompts: opts.prompts } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.conversations ? { conversations: opts.conversations } : {}),
    ...(opts.factDrafts ? { factDrafts: opts.factDrafts } : {}),
    ...(derivedFacts ? { derivedFacts } : {}),
    ...(opts.scanChecker ? { scanChecker: opts.scanChecker } : {}),
    ...(opts.feeds ? { feeds: opts.feeds } : {}),
    ...(opts.boards ? { boards: opts.boards } : {}),
    ...(opts.guidance ? { guidance: opts.guidance } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
  });
  const delivered: AppEvent[] = [];
  engine.subscribe((event) => delivered.push(event));
  const checkEvents = (): void => {
    engine.bus.flush();
    const problems: string[] = [];
    for (const row of listEvents(db, { afterId: startId })) {
      if ((APP_EVENT_TYPES as readonly string[]).includes(row.type)) {
        if (mappers.toAppEvent(row) === null) problems.push(`event ${row.id} (${row.type}) does not validate as an AppEvent, so it would never reach the UI`);
      } else if (!(AUDIT_ONLY_EVENT_TYPES as readonly string[]).includes(row.type)) {
        problems.push(`event ${row.id} has an unknown type ${row.type}`);
      }
    }
    for (const e of delivered) {
      const parsed = AppEventSchema.safeParse(e);
      if (!parsed.success) problems.push(`delivered event ${e.id} (${e.type}) is invalid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    }
    const ids = delivered.map((e) => Number(e.id));
    if (ids.some((id, i) => i > 0 && id <= ids[i - 1]!)) problems.push("subscribers got events out of id order");
    const replayed = engine.replay(startId).map((r) => r.event);
    if (JSON.stringify(replayed) !== JSON.stringify(delivered)) {
      problems.push(`replay(${startId}) has ${replayed.length} events, subscribers got ${delivered.length}`);
    }
    if (problems.length > 0) throw new Error(`event invariants (§10.2 rule 8, §11):\n- ${problems.join("\n- ")}`);
  };
  if (opts.start !== false) await engine.start();
  const all = () => listEvents(db).map(mappers.toAppEvent).filter((e): e is AppEvent => e !== null);
  return {
    db,
    clock,
    files,
    runner,
    browser,
    figma,
    guards,
    masterCv,
    derived,
    paths,
    engine,
    profile,
    events: <T extends AppEventType>(type: T) => all().filter((e): e is EventOfType<T> => e.type === type),
    allEvents: all,
    step: (runId, key, branchKey = "") => getStepByKey(db, runId, key, branchKey),
    tasks: (key) => listTasks(db).filter((t) => key === undefined || `${t.botName}.${t.kind}` === key),
    review: (runId, jobId) => getStepByKey(db, runId, "review", String(jobId))?.output as HumanStepOutput | undefined,
    action: (runId, jobId) => getStepByKey(db, runId, "apply", String(jobId))?.output as ActionStepOutput | undefined,
    idle: async () => {
      await engine.idle();
      checkEvents();
    },
    flush: async () => {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    },
    delivered: () => [...delivered],
    checkEvents,
  };
}
