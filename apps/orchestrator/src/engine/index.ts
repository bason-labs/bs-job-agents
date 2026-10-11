// Workflow engine, task queue, limiter and locks, trust guard, usage-limit watcher, bridge waits,
// scheduler, crash recovery and Lead's tools (spec §3, §5.3, §7, §10). Owned by W2a.
//
//   const engine = createProductionEngine({ db, dataDir, botsDir, runners: createRunners(cfg), workflows });
//   await engine.start();                         // UC-18 recovery, usage pauses, scheduler, queue
//   engine.subscribe((event) => sse.send(event)); // committed shared AppEvents, in order
//   engine.startWorkflow({ workflow: "job-scan", params }, { trigger: "chat" });
//   engine.approve(jobId, { cvVersionId, introText, dryRun? });  // UC-08; applicationId null without an apply link
//   engine.enqueueConversation({ bot, kind, input });       // Lead chat / consult / room (PM2 S2)
//   engine.confirmInjection(jobId);                         // UC-07 b, audited
//   engine.lead.createTask({ botName: "lead", mode: "work" }, { bot, kind, input });  // MCP tools
//
// Test kit for other workers: `./testing/index.js` (FakeRunner, fake clock, fake bridges, harness).
export { Engine, type StartReport, type StartWorkflowOptions } from "./engine.js";
export type { EngineCore, EngineDeps } from "./core.js";
export { DEFAULT_ENGINE_CONFIG, EnginePaths, resolveEngineConfig, type EngineConfig } from "./config.js";
export { EngineError, type EngineErrorCode } from "./errors.js";
export type { EventListener } from "./events.js";
export type {
  BotRegistry,
  BrowserStatusProbe,
  Clock,
  FigmaPort,
  FileStore,
  GuardBlock,
  GuardHooks,
  Logger,
  MasterCvSource,
  MemoryWriter,
  OrphanKiller,
  PdfTextExtractor,
  WorkflowSource,
} from "./ports.js";
export { nodeFileStore, systemClock } from "./system.js";
export {
  botRegistryFrom,
  bridgeGuardHooks,
  chromeBrowserProbe,
  cliOrphanKiller,
  createProductionEngine,
  fileMasterCv,
  memoryWriter,
  pdfTextExtractor,
  type ProductionEngineOptions,
} from "./wiring.js";
export { approvalStatus, type ApproveInput, type ApproveResult } from "./review.js";
export type { ConversationKind, ConversationRequest, ConversationResult, ConversationSink, ConversationSinkContext } from "./conversations.js";
export type { AnswerInput } from "./apply.js";
export { LEAD_TASK_KEYS, type LeadCaller, type LeadTools } from "./lead-tools.js";
export { computeNextRunAt, type SchedulerTick } from "./scheduler.js";
export { resolvePendingQuestion, validateBaAnswer, type QuestionContext, type QuestionResolution } from "./questions.js";
export { checkTaskTrust, authorizeApplyToken, precheckApplyToken, checkToken, type ApplyGuardRequest, type ApplyGuardResult } from "./trust-guard.js";
export { recruiterFileName, registrableHost } from "./apply.js";
export type {
  ActionStepOutput,
  ApplyOutcome,
  FilterStepOutput,
  GateRound,
  GateStepOutput,
  HumanStepOutput,
  JobRef,
  JoinStepOutput,
  MapStepOutput,
  RecordStepOutput,
  ReviewCvOption,
  ReviewDecision,
} from "./state.js";
