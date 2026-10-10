// Bridges to the outside world (spec §4.2, §4.4, §6.2, §9.1): the local Figma bridge and its code
// guard, the Chrome site guard and browser check, PDF tools, and the hook plumbing they share.
// Owned by W2c. Test fakes live in ./testing.js.
export * from "./chrome/index.js";
export * from "./figma/index.js";
export * from "./pdf/index.js";
export { buildHookCommand, resolveHookEntry, shellQuote, type HookCommandOptions, type HookEntry } from "./hooks/command.js";
export { ALLOW, PreToolUseInputSchema, type GuardDecision, type PreToolUseCall } from "./hooks/protocol.js";
export { runPreToolUseHook, type HookExitCode, type HookStreams, type RunHookOptions } from "./hooks/run.js";
export { mergeHookSettings, type ClaudeHookCommand, type ClaudeHookMatcher, type ClaudeHookSettings } from "./hooks/settings.js";
