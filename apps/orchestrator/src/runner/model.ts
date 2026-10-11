// bot.json has one `model` for the bot's engine. When Ba switches the engine in the UI, a model
// name meant for the other engine must not be passed on (codex would reject "sonnet").
import type { Engine } from "@bs-job-agents/shared";

const CLAUDE_MODEL = /^(claude|sonnet|opus|haiku|fable)/i;
const OPENAI_MODEL = /^(gpt|o\d|codex|chatgpt)/i;

/** The model flag value for this engine, or null to use the CLI's default. */
export function modelForEngine(model: string | null | undefined, engine: Engine): string | null {
  if (!model) return null;
  if (engine === "codex" && CLAUDE_MODEL.test(model)) return null;
  if (engine === "claude" && OPENAI_MODEL.test(model)) return null;
  return model;
}
