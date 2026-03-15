import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { AgentArtifact, BacktrackReason, StrategyRecord } from "../types.js";

const recordStrategySchema = Type.Object({
	name: Type.String({ description: "Name of the strategy" }),
	approach: Type.String({ description: "Description of the approach" }),
	parent_id: Type.Optional(Type.String({ description: "ID of the parent strategy, if this is a sub-strategy" })),
});

export function createRecordStrategyTool(
	strategies: StrategyRecord[],
	onArtifact?: (artifact: AgentArtifact) => Promise<void>,
): AgentTool<typeof recordStrategySchema, undefined> {
	return {
		name: "record_strategy",
		label: "Record Strategy",
		description: "Record a new strategy for solving the current task",
		parameters: recordStrategySchema,
		execute: async (_toolCallId, args) => {
			let depth = 0;
			if (args.parent_id) {
				const parent = strategies.find((s) => s.strategy.id === args.parent_id);
				if (parent) {
					depth = parent.strategy.depth + 1;
				}
			}

			const record: StrategyRecord = {
				strategy: {
					id: crypto.randomUUID(),
					name: args.name,
					approach: args.approach,
					parent_id: args.parent_id,
					depth,
				},
				attempts: [],
				duration_ms: 0,
				energy_joules: 0,
			};

			strategies.push(record);

			if (onArtifact) {
				await onArtifact({ type: "strategy", data: record });
			}

			return {
				content: [{ type: "text", text: `Strategy "${args.name}" recorded with ID ${record.strategy.id}` }],
				details: undefined,
			};
		},
	};
}

const recordLessonSchema = Type.Object({
	strategy_id: Type.String({ description: "ID of the strategy this lesson applies to" }),
	failure_type: Type.Union(
		[
			Type.Literal("wrong_approach"),
			Type.Literal("partial_solution"),
			Type.Literal("runtime_error"),
			Type.Literal("timeout"),
		],
		{ description: "Type of failure encountered" },
	),
	lesson: Type.String({ description: "What was learned from this failure" }),
});

export function createRecordLessonTool(
	strategies: StrategyRecord[],
	onArtifact?: (artifact: AgentArtifact) => Promise<void>,
): AgentTool<typeof recordLessonSchema, undefined> {
	return {
		name: "record_lesson",
		label: "Record Lesson",
		description: "Record a lesson learned from a failed strategy attempt",
		parameters: recordLessonSchema,
		execute: async (_toolCallId, args) => {
			const reason: BacktrackReason = {
				strategy_id: args.strategy_id,
				failure_type: args.failure_type,
				lesson: args.lesson,
			};

			const record = strategies.find((s) => s.strategy.id === args.strategy_id);
			if (record) {
				record.backtrack_reason = reason;
			}

			if (onArtifact) {
				await onArtifact({ type: "lesson", data: reason });
			}

			return {
				content: [
					{
						type: "text",
						text: `Lesson recorded for strategy ${args.strategy_id}: ${args.lesson}`,
					},
				],
				details: undefined,
			};
		},
	};
}
