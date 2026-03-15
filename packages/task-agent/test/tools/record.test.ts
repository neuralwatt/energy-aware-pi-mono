import { describe, expect, it, vi } from "vitest";
import { createRecordLessonTool, createRecordStrategyTool } from "../../src/tools/record.js";
import type { AgentArtifact, StrategyRecord } from "../../src/types.js";

describe("createRecordStrategyTool", () => {
	it("creates strategies with unique IDs", async () => {
		const strategies: StrategyRecord[] = [];
		const tool = createRecordStrategyTool(strategies);

		await tool.execute("call-1", { name: "Strategy A", approach: "Try approach A" });
		await tool.execute("call-2", { name: "Strategy B", approach: "Try approach B" });

		expect(strategies).toHaveLength(2);
		expect(strategies[0].strategy.id).not.toBe(strategies[1].strategy.id);
	});

	it("records depth 0 for root strategies", async () => {
		const strategies: StrategyRecord[] = [];
		const tool = createRecordStrategyTool(strategies);

		await tool.execute("call-1", { name: "Root", approach: "Root approach" });

		expect(strategies[0].strategy.depth).toBe(0);
		expect(strategies[0].strategy.parent_id).toBeUndefined();
	});

	it("records correct depth for child strategies", async () => {
		const strategies: StrategyRecord[] = [];
		const tool = createRecordStrategyTool(strategies);

		await tool.execute("call-1", { name: "Root", approach: "Root approach" });
		const parentId = strategies[0].strategy.id;

		await tool.execute("call-2", { name: "Child", approach: "Child approach", parent_id: parentId });

		expect(strategies[1].strategy.depth).toBe(1);
		expect(strategies[1].strategy.parent_id).toBe(parentId);
	});

	it("calls onArtifact callback", async () => {
		const strategies: StrategyRecord[] = [];
		const onArtifact = vi.fn<(artifact: AgentArtifact) => Promise<void>>().mockResolvedValue(undefined);
		const tool = createRecordStrategyTool(strategies, onArtifact);

		await tool.execute("call-1", { name: "Test", approach: "Test approach" });

		expect(onArtifact).toHaveBeenCalledOnce();
		const artifact = onArtifact.mock.calls[0][0];
		expect(artifact.type).toBe("strategy");
		if (artifact.type === "strategy") {
			expect(artifact.data.strategy.name).toBe("Test");
		}
	});
});

describe("createRecordLessonTool", () => {
	it("attaches backtrack reason to matching strategy", async () => {
		const strategies: StrategyRecord[] = [];
		const strategyTool = createRecordStrategyTool(strategies);
		await strategyTool.execute("call-1", { name: "Failing", approach: "Bad approach" });
		const strategyId = strategies[0].strategy.id;

		const lessonTool = createRecordLessonTool(strategies);
		await lessonTool.execute("call-2", {
			strategy_id: strategyId,
			failure_type: "wrong_approach" as const,
			lesson: "This approach does not work",
		});

		expect(strategies[0].backtrack_reason).toBeDefined();
		expect(strategies[0].backtrack_reason!.strategy_id).toBe(strategyId);
		expect(strategies[0].backtrack_reason!.failure_type).toBe("wrong_approach");
		expect(strategies[0].backtrack_reason!.lesson).toBe("This approach does not work");
	});

	it("calls onArtifact with lesson artifact", async () => {
		const strategies: StrategyRecord[] = [];
		const strategyTool = createRecordStrategyTool(strategies);
		await strategyTool.execute("call-1", { name: "Test", approach: "Test approach" });
		const strategyId = strategies[0].strategy.id;

		const onArtifact = vi.fn<(artifact: AgentArtifact) => Promise<void>>().mockResolvedValue(undefined);
		const lessonTool = createRecordLessonTool(strategies, onArtifact);
		await lessonTool.execute("call-2", {
			strategy_id: strategyId,
			failure_type: "runtime_error" as const,
			lesson: "Segfault in sandbox",
		});

		expect(onArtifact).toHaveBeenCalledOnce();
		const artifact = onArtifact.mock.calls[0][0];
		expect(artifact.type).toBe("lesson");
		if (artifact.type === "lesson") {
			expect(artifact.data.lesson).toBe("Segfault in sandbox");
		}
	});
});
