// Engine test kit (§12) for the engine's own tests and later workers' integration and e2e tests:
// FakeRunner with scripted scenarios, a manual clock, in-memory files, fake Chrome / Figma /
// guard hooks / PDF text, and a whole engine on in-memory SQLite.
export { FakeClock } from "./fake-clock.js";
export { FakeRunner, defaultFakeResult, fake, fakeFrameName, type FakeScript } from "./fake-runner.js";
export {
  FakeBrowserProbe,
  FakeFigmaPort,
  FakeGuardHooks,
  FakeMasterCv,
  FakePdfText,
  MemoryFileStore,
  staticBotRegistry,
  staticWorkflowSource,
} from "./fakes.js";
export { MemoryDerivedFacts } from "./derived-facts.js";
export { BOTS_DIR, DATA_DIR, LONG_WAIT_CONFIG, createTestEngine, type TestEngine, type TestEngineOptions } from "./harness.js";
