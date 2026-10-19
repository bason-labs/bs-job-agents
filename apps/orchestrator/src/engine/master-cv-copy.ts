// The per-task copy of data/master-cv.yaml (SEC-18, CV auto-extend §5.9): research.fit, cv.tailor
// and qa.review read the same filtered projection: derived facts whose source changed are left out,
// and a derived fact says only `derived: true` and the ids it rests on. The fact ids in the copy are
// what a tailored CV may cite. A file that does not parse is copied as it is (nothing to filter).
import { MasterCvSchema, masterCvForTasks } from "@bs-job-agents/shared";
import { parse, stringify } from "yaml";
import type { FileStore } from "./ports.js";

const HEADER = "# Ba's master CV facts (spec §6.1): this task's copy. Facts marked derived were added from his facts; flagged ones are left out.\n";

/** Write the task's copy; returns the fact ids it holds, or null when the file was copied unparsed. */
export async function writeTaskMasterCv(files: FileStore, from: string, to: string): Promise<{ factIds: ReadonlySet<string> | null }> {
  const text = await files.readText(from);
  let parsed: ReturnType<typeof MasterCvSchema.safeParse> | null = null;
  if (text !== null) {
    try {
      parsed = MasterCvSchema.safeParse(parse(text));
    } catch {
      parsed = null;
    }
  }
  if (!parsed?.success) {
    // Missing (the copy throws, as before) or not a valid master CV: the bot reads what is there.
    await files.copy(from, to);
    return { factIds: null };
  }
  const projection = masterCvForTasks(parsed.data);
  await files.writeText(to, HEADER + stringify(projection, { lineWidth: 0 }));
  return { factIds: new Set(projection.facts.map((f) => f.id)) };
}
