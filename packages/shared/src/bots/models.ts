// bot.json has one `model` for the bot's engine, and Ba may pick another on the Bots screen. A model
// name meant for the other engine must never be passed on (codex would reject "sonnet"). Shared so
// the orchestrator (runner, PATCH /bots/:name) and the web app (Bots screen, mock) agree.
import type { Engine } from "../common/primitives.js";

const CLAUDE_MODEL = /^(claude|sonnet|opus|haiku|fable)/i;
const OPENAI_MODEL = /^(gpt|o\d|codex|chatgpt)/i;

/** The model flag value for this engine, or null to use the CLI's default. */
export function modelForEngine(model: string | null | undefined, engine: Engine): string | null {
  if (!model) return null;
  if (engine === "codex" && CLAUDE_MODEL.test(model)) return null;
  if (engine === "claude" && OPENAI_MODEL.test(model)) return null;
  return model;
}

/** Ba's model choice (Bots screen) is valid for `engine`: never one meant for the other engine. */
export function modelSuitsEngine(model: string, engine: Engine): boolean {
  return modelForEngine(model, engine) !== null;
}
