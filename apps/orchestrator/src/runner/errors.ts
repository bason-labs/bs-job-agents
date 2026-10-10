// Errors that stop a task before any CLI is spawned (fail closed).

/** The runner config lacks something this bot needs (an MCP server, a guard hook). */
export class RunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerConfigError";
  }
}

/** The task itself is not runnable (wrong engine, bad input, read dir or site). */
export class TaskSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSetupError";
  }
}
