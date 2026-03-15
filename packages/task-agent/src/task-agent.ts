import type { TaskAgentConfig, TaskResult } from "./types.js";

// Stub — implementation will be filled by agent
export class TaskAgent {
	constructor(_config: TaskAgentConfig) {
		throw new Error("Not implemented");
	}

	async *run(): AsyncGenerator<import("./types.js").TaskAgentEvent, TaskResult> {
		yield { type: "task_start" as const, task: "" };
		throw new Error("Not implemented");
	}
}
