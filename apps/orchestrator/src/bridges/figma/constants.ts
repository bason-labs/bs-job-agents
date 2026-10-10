// Figma bridge constants (spec §6.2, spike S3b).

/** Ba's CV file "Resume (Community) V2". */
export const DEFAULT_CV_FILE_KEY = "kJFoXNrTfFOtkQ515c0jHk";

/** The only page bots may change: one frame per CV version, `<COMPANY>_<ROLE>_<LANG>_v<n>`. */
export const DRAFTS_PAGE_NAME = "Drafts";

/** Pages known to hold templates; every page other than Drafts is protected anyway. */
export const KNOWN_PROTECTED_PAGES = ["resume", "components"] as const;

/** figma-console-mcp caps one figma_execute call at 30 s (spike S3b). */
export const FIGMA_EXECUTE_MAX_MS = 30_000;

/** Pinned bridge version (package.json pins the same). */
export const FIGMA_CONSOLE_MCP_VERSION = "1.40.9";
