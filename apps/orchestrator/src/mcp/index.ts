// Orchestrator MCP server exposing Lead's tools (spec §3 rule 5, §4.2; PM2 S17). Owned by W3a.
//
//   const capabilities = new CapabilityStore();
//   const mcp = await startMcpServer({ capabilities, tools: () => ({ engine, proposals, capabilities }) });
//   const runners = createOrchestratorRunners({ capabilities, server: () => mcp });
//
// Each Lead spawn gets http://127.0.0.1:<port>/mcp/<token>; the token maps to its LeadCaller, task
// and room, and is revoked when the spawn returns.
export { CapabilityStore, chatModeOfKind, type Capability, type LeadToolAction, type MintInput } from "./capabilities.js";
export { MCP_PATH_PREFIX, MCP_SERVER_NAME, startMcpServer, type McpServerDeps, type OrchestratorMcpServer } from "./server.js";
export { MESSAGE_USER_CAP, ORCHESTRATOR_TOOLS, PROPOSE_WORKFLOW_CAP, TOOL_DEFINITIONS, callTool, type OrchestratorTool, type ToolDeps, type ToolResult } from "./tools.js";
export { CAPABILITY_TTL_MARGIN_MS, LeadMcpRunner, createOrchestratorRunners, orchestratorServerConfig } from "./runner.js";
