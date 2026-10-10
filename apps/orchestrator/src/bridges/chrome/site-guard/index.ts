// Chrome site guard (spec §4.4, §10.2 rule 7): PreToolUse hook for Claude in Chrome.
export { hostAllowed, InvalidAllowlistError, normalizeAllowlist } from "./allowlist.js";
export { CHROME_TOOL_PREFIX, evaluateChromeToolCall, SITE_GUARD_TOOLS, type SiteGuardPolicy } from "./guard.js";
export { checkPageJavascript } from "./javascript.js";
export { buildSiteGuardSettings, siteGuardHookCommand, type SiteGuardSettingsOptions } from "./settings.js";
export { checkNavigateUrl, checkPageUrlValue } from "./url.js";
