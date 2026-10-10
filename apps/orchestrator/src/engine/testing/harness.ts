// A whole engine on an in-memory SQLite database with every outside dependency faked: FakeRunner
// for both engines, a manual clock, in-memory files, fake Chrome, Figma, guard hooks and PDF text.
// For the engine's own tests and for later workers' integration tests (W3, W4).
import type { AppEvent, AppEventType, BotDefinitionInput, EventOfType, SearchSource } from "@bs-job-agents/shared";
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
import type { OrphanKiller } from "../ports.js";
import type { ActionStepOutput, HumanStepOutput } from "../state.js";
import { FakeClock } from "./fake-clock.js";
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
  idle(): Promise<void>;
  /** Let started tasks reach their runner (e.g. before advancing the clock past a FakeRunner delay). */
  flush(): Promise<void>;
}

export const DATA_DIR = "/data";
export const BOTS_DIR = "/bots";

export async function createTestEngine(opts: TestEngineOptions = {}): Promise<TestEngine> {
  const fresh = opts.db === undefined;
  const db = opts.db ?? openTestDb();
  if (fresh) seedBots(db);
  const clock = opts.clock ?? new FakeClock(T0);
  const files = opts.files ?? new MemoryFileStore();
  const runner = new FakeRunner({ clock });
  const browser = new FakeBrowserProbe();
  const figma = new FakeFigmaPort(files);
  const guards = new FakeGuardHooks(files);
  const masterCv = new FakeMasterCv(`${DATA_DIR}/master-cv.yaml`, files);
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
    config: opts.config,
    ...(opts.processes ? { processes: opts.processes } : {}),
  });
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
    paths,
    engine,
    profile,
    events: <T extends AppEventType>(type: T) => all().filter((e): e is EventOfType<T> => e.type === type),
    allEvents: all,
    step: (runId, key, branchKey = "") => getStepByKey(db, runId, key, branchKey),
    tasks: (key) => listTasks(db).filter((t) => key === undefined || `${t.botName}.${t.kind}` === key),
    review: (runId, jobId) => getStepByKey(db, runId, "review", String(jobId))?.output as HumanStepOutput | undefined,
    action: (runId, jobId) => getStepByKey(db, runId, "apply", String(jobId))?.output as ActionStepOutput | undefined,
    idle: () => engine.idle(),
    flush: async () => {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
