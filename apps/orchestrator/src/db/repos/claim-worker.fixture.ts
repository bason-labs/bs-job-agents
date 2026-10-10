// Child process used by tasks.test.ts to claim tasks concurrently with another
// process on the same SQLite file. Prints "ready", waits for stdin to close,
// claims until the queue is empty, then prints "ids:[…]".
import { openDb } from "../client.js";
import { claimNextTask } from "./tasks.js";

const path = process.argv[2];
if (!path) throw new Error("usage: claim-worker.fixture.ts <db path>");

const db = openDb(path);
const pause = new Int32Array(new SharedArrayBuffer(4));
process.stdout.write("ready\n");

process.stdin.resume();
process.stdin.on("end", () => {
  const ids: number[] = [];
  for (;;) {
    const task = claimNextTask(db);
    if (!task) break;
    ids.push(task.id);
    // Simulate a little work so the two processes interleave.
    Atomics.wait(pause, 0, 0, 1);
  }
  db.$client.close();
  process.stdout.write(`ids:${JSON.stringify(ids)}\n`);
  process.exit(0);
});
