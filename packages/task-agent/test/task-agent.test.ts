import { describe, expect, it } from "vitest";
import { TaskAgent } from "../src/task-agent.js";
import { ToolRegistry } from "../src/tool-registry.js";
import type { TaskAgentConfig, TaskAgentEvent, TaskResult } from "../src/types.js";

// TaskAgent requires a real Model object and LLM connection to fully run.
// These tests verify construction, configuration, and the event/result contract
// without making actual LLM calls.

function createMinimalConfig(overrides?: Partial<TaskAgentConfig>): TaskAgentConfig {
	return {
		task: "Test task",
		tools: new ToolRegistry(),
		model: {
			provider: "test",
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			capabilities: { tools: true, images: false, video: false, pdf: false, reasoning: false },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxOutput: 1024,
		} as any,
		...overrides,
	};
}

describe("TaskAgent", () => {
	it("constructs with minimal config", () => {
		const agent = new TaskAgent(createMinimalConfig());
		expect(agent).toBeDefined();
	});

	it("run() returns an async generator", () => {
		const agent = new TaskAgent(createMinimalConfig());
		const gen = agent.run();
		expect(gen[Symbol.asyncIterator]).toBeDefined();
	});

	it("first yielded event is task_start", async () => {
		const agent = new TaskAgent(createMinimalConfig({ task: "Sort a list" }));
		const gen = agent.run();

		// First event should be task_start (before any LLM call)
		const first = await gen.next();
		expect(first.done).toBe(false);
		expect(first.value).toEqual({ type: "task_start", task: "Sort a list" });

		// Clean up - the generator will try to call the LLM next,
		// which will fail without a real provider. That's expected.
		await gen.return(undefined as unknown as TaskResult);
	});

	it("accepts prior knowledge in config", () => {
		const agent = new TaskAgent(
			createMinimalConfig({
				priorKnowledge: [
					{
						source: "previous_run",
						problem_similarity: "same domain",
						lessons: ["greedy fails on dense graphs"],
						strategies_to_avoid: ["greedy"],
					},
				],
			}),
		);
		expect(agent).toBeDefined();
	});

	it("accepts onEvent callback in config", async () => {
		const events: TaskAgentEvent[] = [];
		const agent = new TaskAgent(
			createMinimalConfig({
				onEvent: (e) => events.push(e),
			}),
		);

		const gen = agent.run();
		await gen.next(); // task_start
		await gen.return(undefined as unknown as TaskResult);

		// task_start is yielded, not emitted via onEvent (it goes through the generator)
		// but the decomposition loop events would go through onEvent
	});

	it("respects maxCalls and maxDepth defaults", () => {
		// Just verify construction doesn't throw with defaults
		const agent = new TaskAgent(createMinimalConfig());
		expect(agent).toBeDefined();
	});

	it("accepts custom maxCalls and maxDepth", () => {
		const agent = new TaskAgent(
			createMinimalConfig({
				maxCalls: 10,
				maxDepth: 3,
			}),
		);
		expect(agent).toBeDefined();
	});

	it("accepts tools in registry", () => {
		const registry = new ToolRegistry();
		registry.register({
			name: "test_tool",
			label: "Test Tool",
			description: "A test tool",
			parameters: { type: "object", properties: {} } as any,
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
		});

		const agent = new TaskAgent(createMinimalConfig({ tools: registry }));
		expect(agent).toBeDefined();
	});
});
