// Skill self-repair (sub-project 4 §5.3): what the shared screenSkillDraft needs to know about one
// source, built from the code that enforces it at run time: the source's hosts (SOURCE_ADAPTERS and
// its access record's endpoints), the research bot's tool grant (runner/tools.ts), the limits the
// checker holds (sources.ts) and the checker's note readers. The engine's repair flow and the CI test
// over every committed skill (skills.test.ts) both build it here, so they apply one rule set.
import {
  internalGetEndpoints,
  isBoardSource,
  sourceAccessRecord,
  usablePublicEndpoints,
  type SkillScreenContext,
} from "@bs-job-agents/shared";
import { CHROME_READ_TOOLS, CLAUDE_CHROME_TOOLS } from "../runner/tools.js";
import { isLayoutChangedNote, isNoResultsNote } from "./checker.js";
import { SOURCE_ADAPTERS, isAdapterSource, scanJobLimit, type AdapterSource } from "./sources.js";

/** The skill folder of a source: bots/research/skills/source-<dir>/ (career_site → career-site). */
export const skillDirOf = (source: string): string => source.replace(/_/g, "-");

/** Sources with a skill a repair may rewrite (every source Research reads in Chrome). */
export const isSkillSource = (source: string): source is AdapterSource => isAdapterSource(source);

/**
 * A career site is any employer's site (SOURCE_ADAPTERS lists no host); its skill may name only the
 * applicant-tracking platforms it describes.
 */
const CAREER_SITE_PLATFORMS = ["greenhouse.io", "lever.co", "workable.com"] as const;

/** Built-in Claude Code tools a skill could name; only Read and WebSearch are ever granted to Research. */
const BUILT_IN_TOOLS = ["Read", "WebSearch", "WebFetch", "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "Task", "TodoWrite"] as const;

/** The tool names `allowedTools` (bot.json vocabulary) gives the bot. */
export function grantedToolNames(allowedTools: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of allowedTools) {
    const t = raw.trim();
    if (t.toLowerCase() === "read" || t.startsWith("skill:")) out.add("Read");
    else if (t === "web_search") out.add("WebSearch");
    else if (t === "chrome:read") for (const c of CHROME_READ_TOOLS) out.add(c);
  }
  return [...out];
}

/** The hosts a source's skill may name. */
export function skillHosts(source: AdapterSource): string[] {
  if (source === "career_site") return [...CAREER_SITE_PLATFORMS];
  const hosts = new Set<string>(SOURCE_ADAPTERS[source].hosts);
  if (isBoardSource(source)) {
    const record = sourceAccessRecord(source);
    for (const e of [...usablePublicEndpoints(record), ...internalGetEndpoints(record)]) hosts.add(e.host.toLowerCase());
  }
  return [...hosts];
}

export function skillScreenContext(source: AdapterSource, opts: { allowedTools: readonly string[]; current: string | null }): SkillScreenContext {
  const adapter = SOURCE_ADAPTERS[source];
  return {
    dir: skillDirOf(source),
    hosts: skillHosts(source),
    tools: { granted: grantedToolNames(opts.allowedTools), known: [...BUILT_IN_TOOLS, ...CLAUDE_CHROME_TOOLS] },
    current: opts.current,
    limits: {
      jobLimit: scanJobLimit(Number.MAX_SAFE_INTEGER),
      jobLimitPerMaxJob: scanJobLimit(1),
      maxPageViews: adapter.maxPageViews,
      delaySec: adapter.minDelayMs > 0 ? { min: adapter.minDelayMs / 1000, max: adapter.maxDelayMs / 1000 } : null,
    },
    notes: { layoutChanged: isLayoutChangedNote, noResults: isNoResultsNote },
  };
}
