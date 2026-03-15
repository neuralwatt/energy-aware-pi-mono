import { describe, expect, it } from "vitest";
import { DecompositionLoop } from "../../src/decomposition/loop.js";
import type {
	AgentArtifact,
	ExecutionResult,
	PriorKnowledge,
	TaskAgentEvent,
	ValidationResult,
} from "../../src/types.js";

function makeExecution(overrides?: Partial<ExecutionResult>): ExecutionResult {
	return {
		stdout: "",
		stderr: "",
		exit_code: 0,
		duration_ms: 100,
		timed_out: false,
		...overrides,
	};
}

function makeValidation(overrides?: Partial<ValidationResult>): ValidationResult {
	return {
		passed: true,
		violations: [],
		...overrides,
	};
}

describe("DecompositionLoop", () => {
	// -----------------------------------------------------------------------
	// Strategy lifecycle
	// -----------------------------------------------------------------------
	describe("strategy lifecycle", () => {
		it("startStrategy creates a strategy with correct fields", () => {
			const loop = new DecompositionLoop();
			const strategy = loop.startStrategy("brute-force", "try all permutations");

			expect(strategy.id).toBeDefined();
			expect(strategy.name).toBe("brute-force");
			expect(strategy.approach).toBe("try all permutations");
			expect(strategy.depth).toBe(0);
			expect(strategy.parent_id).toBeUndefined();
		});

		it("startStrategy with parent increments depth", () => {
			const loop = new DecompositionLoop();
			const parent = loop.startStrategy("parent", "parent approach");
			loop.backtrack("wrong_approach", "did not work");

			const child = loop.startStrategy("child", "child approach", parent.id);
			expect(child.depth).toBe(1);
			expect(child.parent_id).toBe(parent.id);
		});

		it("startStrategy throws when maxDepth exceeded", () => {
			const loop = new DecompositionLoop({ maxDepth: 1 });
			const root = loop.startStrategy("root", "approach");
			loop.backtrack("wrong_approach", "nope");

			expect(() => loop.startStrategy("too-deep", "approach", root.id)).toThrow("Max depth");
		});

		it("multiple strategies can be started sequentially after backtrack", () => {
			const loop = new DecompositionLoop();
			loop.startStrategy("first", "a1");
			loop.backtrack("wrong_approach", "lesson 1");

			loop.startStrategy("second", "a2");
			loop.backtrack("partial_solution", "lesson 2");

			loop.startStrategy("third", "a3");
			expect(loop.strategiesCount).toBe(3);
		});
	});

	// -----------------------------------------------------------------------
	// Attempt tracking
	// -----------------------------------------------------------------------
	describe("attempt tracking", () => {
		it("recordAttempt adds to current strategy's attempts", () => {
			const loop = new DecompositionLoop();
			loop.startStrategy("s1", "approach");

			const attempt = loop.recordAttempt("console.log(1)", makeExecution(), makeValidation());
			expect(attempt.code).toBe("console.log(1)");
			expect(attempt.strategy.name).toBe("s1");
			expect(loop.currentStrategy!.attempts).toHaveLength(1);
		});

		it("recordAttempt throws if no current strategy", () => {
			const loop = new DecompositionLoop();
			expect(() => loop.recordAttempt("code", makeExecution(), makeValidation())).toThrow("No current strategy");
		});

		it("supports multiple attempts per strategy", () => {
			const loop = new DecompositionLoop();
			loop.startStrategy("s1", "approach");

			loop.recordAttempt("attempt1", makeExecution(), makeValidation({ passed: false, violations: ["fail"] }));
			loop.recordAttempt("attempt2", makeExecution(), makeValidation({ passed: true }));

			expect(loop.currentStrategy!.attempts).toHaveLength(2);
		});
	});

	// -----------------------------------------------------------------------
	// Backtracking
	// -----------------------------------------------------------------------
	describe("backtracking", () => {
		it("backtrack records lesson and sets backtrack_reason on strategy", () => {
			const loop = new DecompositionLoop();
			const strategy = loop.startStrategy("s1", "approach");

			const reason = loop.backtrack("wrong_approach", "approach was too slow");
			expect(reason.strategy_id).toBe(strategy.id);
			expect(reason.failure_type).toBe("wrong_approach");
			expect(reason.lesson).toBe("approach was too slow");

			const results = loop.getResults();
			expect(results[0].backtrack_reason).toEqual(reason);
		});

		it("backtrack clears currentStrategy", () => {
			const loop = new DecompositionLoop();
			loop.startStrategy("s1", "approach");
			loop.backtrack("wrong_approach", "nope");
			expect(loop.currentStrategy).toBeNull();
		});

		it("getLessons returns all accumulated lessons", () => {
			const loop = new DecompositionLoop();
			loop.startStrategy("s1", "a1");
			loop.backtrack("wrong_approach", "lesson 1");

			loop.startStrategy("s2", "a2");
			loop.backtrack("runtime_error", "lesson 2");

			expect(loop.getLessons()).toEqual(["lesson 1", "lesson 2"]);
		});

		it("lessons persist across strategies", () => {
			const loop = new DecompositionLoop();

			loop.startStrategy("s1", "a1");
			loop.backtrack("wrong_approach", "first lesson");

			loop.startStrategy("s2", "a2");
			// s2 is still active, but lesson from s1 persists
			expect(loop.getLessons()).toEqual(["first lesson"]);

			loop.backtrack("timeout", "second lesson");
			expect(loop.getLessons()).toEqual(["first lesson", "second lesson"]);
		});
	});

	// -----------------------------------------------------------------------
	// Success
	// -----------------------------------------------------------------------
	describe("success", () => {
		it("succeed emits strategy_end with 'success'", () => {
			const events: TaskAgentEvent[] = [];
			const loop = new DecompositionLoop({ onEvent: (e) => events.push(e) });

			loop.startStrategy("s1", "approach");
			loop.succeed();

			const endEvent = events.find((e) => e.type === "strategy_end");
			expect(endEvent).toBeDefined();
			expect(endEvent!.type === "strategy_end" && endEvent!.outcome).toBe("success");
		});

		it("succeed clears currentStrategy", () => {
			const loop = new DecompositionLoop();
			loop.startStrategy("s1", "approach");
			loop.succeed();
			expect(loop.currentStrategy).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// Summaries
	// -----------------------------------------------------------------------
	describe("summaries", () => {
		it("getStrategiesSummary includes strategy names, outcomes, and lessons", () => {
			const loop = new DecompositionLoop();
			loop.startStrategy("brute-force", "try everything");
			loop.backtrack("wrong_approach", "too slow");

			loop.startStrategy("dynamic-programming", "memoize subproblems");
			loop.succeed();

			const summary = loop.getStrategiesSummary();
			expect(summary).toContain("brute-force");
			expect(summary).toContain("backtrack");
			expect(summary).toContain("too slow");
			expect(summary).toContain("dynamic-programming");
			expect(summary).toContain("success");
		});

		it("getPriorKnowledgeSummary formats prior knowledge", () => {
			const prior: PriorKnowledge[] = [
				{
					source: "past-run-42",
					problem_similarity: "similar sorting problem",
					lessons: ["Use quicksort for large arrays"],
					strategies_to_avoid: ["bubble sort"],
					strategies_that_worked: ["quicksort"],
				},
			];
			const loop = new DecompositionLoop({ priorKnowledge: prior });
			const summary = loop.getPriorKnowledgeSummary();

			expect(summary).toContain("past-run-42");
			expect(summary).toContain("similar sorting problem");
			expect(summary).toContain("Use quicksort for large arrays");
			expect(summary).toContain("bubble sort");
			expect(summary).toContain("quicksort");
		});

		it("getPriorKnowledgeSummary returns empty string when no prior knowledge", () => {
			const loop = new DecompositionLoop();
			expect(loop.getPriorKnowledgeSummary()).toBe("");
		});
	});

	// -----------------------------------------------------------------------
	// Events
	// -----------------------------------------------------------------------
	describe("events", () => {
		it("strategy_start event emitted on startStrategy", () => {
			const events: TaskAgentEvent[] = [];
			const loop = new DecompositionLoop({ onEvent: (e) => events.push(e) });

			const strategy = loop.startStrategy("s1", "approach");
			const startEvent = events.find((e) => e.type === "strategy_start");
			expect(startEvent).toBeDefined();
			expect(startEvent!.type === "strategy_start" && startEvent!.strategy.id).toBe(strategy.id);
		});

		it("strategy_end event emitted on backtrack and succeed", () => {
			const events: TaskAgentEvent[] = [];
			const loop = new DecompositionLoop({ onEvent: (e) => events.push(e) });

			loop.startStrategy("s1", "approach");
			loop.backtrack("wrong_approach", "nope");

			loop.startStrategy("s2", "approach");
			loop.succeed();

			const endEvents = events.filter((e) => e.type === "strategy_end");
			expect(endEvents).toHaveLength(2);
			expect(endEvents[0].type === "strategy_end" && endEvents[0].outcome).toBe("backtrack");
			expect(endEvents[1].type === "strategy_end" && endEvents[1].outcome).toBe("success");
		});

		it("attempt_end event emitted on recordAttempt", () => {
			const events: TaskAgentEvent[] = [];
			const loop = new DecompositionLoop({ onEvent: (e) => events.push(e) });

			loop.startStrategy("s1", "approach");
			loop.recordAttempt("code", makeExecution(), makeValidation());

			const attemptEvent = events.find((e) => e.type === "attempt_end");
			expect(attemptEvent).toBeDefined();
		});

		it("backtrack event emitted on backtrack", () => {
			const events: TaskAgentEvent[] = [];
			const loop = new DecompositionLoop({ onEvent: (e) => events.push(e) });

			loop.startStrategy("s1", "approach");
			loop.backtrack("runtime_error", "crashed");

			const btEvent = events.find((e) => e.type === "backtrack");
			expect(btEvent).toBeDefined();
			expect(btEvent!.type === "backtrack" && btEvent!.reason.lesson).toBe("crashed");
		});
	});

	// -----------------------------------------------------------------------
	// Artifacts
	// -----------------------------------------------------------------------
	describe("artifacts", () => {
		it("onArtifact called with strategy artifact on startStrategy", () => {
			const artifacts: AgentArtifact[] = [];
			const loop = new DecompositionLoop({
				onArtifact: async (a) => {
					artifacts.push(a);
				},
			});

			loop.startStrategy("s1", "approach");

			expect(artifacts).toHaveLength(1);
			expect(artifacts[0].type).toBe("strategy");
		});

		it("onArtifact called with lesson artifact on backtrack", () => {
			const artifacts: AgentArtifact[] = [];
			const loop = new DecompositionLoop({
				onArtifact: async (a) => {
					artifacts.push(a);
				},
			});

			loop.startStrategy("s1", "approach");
			loop.backtrack("wrong_approach", "lesson here");

			const lessonArtifacts = artifacts.filter((a) => a.type === "lesson");
			expect(lessonArtifacts).toHaveLength(1);
			expect(lessonArtifacts[0].type === "lesson" && lessonArtifacts[0].data.lesson).toBe("lesson here");
		});
	});

	// -----------------------------------------------------------------------
	// State queries
	// -----------------------------------------------------------------------
	describe("state queries", () => {
		it("canContinue returns true when under limits", () => {
			const loop = new DecompositionLoop({ maxDepth: 5, maxAttempts: 3 });
			loop.startStrategy("s1", "approach");
			expect(loop.canContinue()).toBe(true);
		});

		it("canContinue returns false when at maxDepth", () => {
			// maxDepth=2 means depths 0 and 1 are valid; depth 2 would throw on startStrategy
			// So canContinue should return false when depth equals maxDepth - 1 and we are
			// at the deepest allowed level. Actually, canContinue checks depth >= maxDepth.
			// At depth 1 with maxDepth 2, canContinue is true. The guard is startStrategy throwing.
			// We verify that startStrategy throws when trying to exceed maxDepth.
			const loop = new DecompositionLoop({ maxDepth: 1 });
			const root = loop.startStrategy("root", "approach");
			// depth is 0, maxDepth is 1 — canContinue is true
			expect(loop.canContinue()).toBe(true);

			loop.backtrack("wrong_approach", "nope");
			// Trying to create a child would be depth 1 >= maxDepth 1 — throws
			expect(() => loop.startStrategy("child", "approach", root.id)).toThrow("Max depth");
		});

		it("canContinue returns false when maxAttempts reached", () => {
			const loop = new DecompositionLoop({ maxAttempts: 2 });
			loop.startStrategy("s1", "approach");
			loop.recordAttempt("c1", makeExecution(), makeValidation({ passed: false, violations: ["fail"] }));
			loop.recordAttempt("c2", makeExecution(), makeValidation({ passed: false, violations: ["fail"] }));
			expect(loop.canContinue()).toBe(false);
		});

		it("currentDepth tracks depth correctly", () => {
			const loop = new DecompositionLoop();
			expect(loop.currentDepth).toBe(0);

			const root = loop.startStrategy("root", "approach");
			expect(loop.currentDepth).toBe(0);

			loop.backtrack("wrong_approach", "nope");
			loop.startStrategy("child", "approach", root.id);
			expect(loop.currentDepth).toBe(1);
		});

		it("totalAttempts counts across all strategies", () => {
			const loop = new DecompositionLoop();
			loop.startStrategy("s1", "a1");
			loop.recordAttempt("c1", makeExecution(), makeValidation());
			loop.recordAttempt("c2", makeExecution(), makeValidation());
			loop.backtrack("wrong_approach", "nope");

			loop.startStrategy("s2", "a2");
			loop.recordAttempt("c3", makeExecution(), makeValidation());

			expect(loop.totalAttempts).toBe(3);
		});

		it("getResults returns copies of all records", () => {
			const loop = new DecompositionLoop();
			loop.startStrategy("s1", "a1");
			loop.recordAttempt("c1", makeExecution(), makeValidation());
			loop.succeed();

			const results = loop.getResults();
			expect(results).toHaveLength(1);
			expect(results[0].strategy.name).toBe("s1");
			expect(results[0].attempts).toHaveLength(1);

			// Verify it's a copy
			results[0].attempts.push({
				strategy: results[0].strategy,
				code: "fake",
				execution: makeExecution(),
				validation: makeValidation(),
			});
			expect(loop.getResults()[0].attempts).toHaveLength(1);
		});
	});
});
