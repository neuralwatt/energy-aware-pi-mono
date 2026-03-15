import type { EnergyBudget, RuntimePolicy } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { ToolRegistry } from "./tool-registry.js";

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface SandboxProvider {
	execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

export interface ExecutionRequest {
	code: string;
	language: "typescript" | "python" | "javascript";
	timeout_ms?: number;
	memory_mb?: number;
	stdin?: string;
}

export interface ExecutionResult {
	stdout: string;
	stderr: string;
	exit_code: number;
	duration_ms: number;
	timed_out: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
	passed: boolean;
	/** 0-1, for partial credit (e.g. 7/10 tests passing = 0.7) */
	score?: number;
	violations: string[];
	details?: unknown;
}

/** A validator is a pure function: solution in, result out. No LLM involved. */
export type Validator<TSolution = unknown> = (solution: TSolution) => ValidationResult | Promise<ValidationResult>;

// ---------------------------------------------------------------------------
// Strategy & Decomposition
// ---------------------------------------------------------------------------

export interface Strategy {
	id: string;
	name: string;
	approach: string;
	parent_id?: string;
	depth: number;
}

export interface Attempt {
	strategy: Strategy;
	code: string;
	execution: ExecutionResult;
	validation: ValidationResult;
}

export interface BacktrackReason {
	strategy_id: string;
	failure_type: "wrong_approach" | "partial_solution" | "runtime_error" | "timeout";
	lesson: string;
}

export interface StrategyRecord {
	strategy: Strategy;
	attempts: Attempt[];
	backtrack_reason?: BacktrackReason;
	duration_ms: number;
	energy_joules: number;
}

// ---------------------------------------------------------------------------
// Prior Knowledge & Artifacts (the Fugue seam)
// ---------------------------------------------------------------------------

export interface PriorKnowledge {
	source: string;
	problem_similarity: string;
	lessons: string[];
	strategies_to_avoid?: string[];
	strategies_that_worked?: string[];
}

export type AgentArtifact =
	| { type: "strategy"; data: StrategyRecord }
	| { type: "lesson"; data: BacktrackReason }
	| { type: "solution"; data: { solution: unknown; validation: ValidationResult } };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type TaskAgentEvent =
	| { type: "task_start"; task: string }
	| { type: "task_end"; result: TaskResult }
	| { type: "strategy_start"; strategy: Strategy }
	| { type: "strategy_end"; strategy: Strategy; outcome: "success" | "backtrack" }
	| { type: "attempt_start"; strategy_id: string; attempt_number: number }
	| { type: "attempt_end"; attempt: Attempt }
	| { type: "backtrack"; reason: BacktrackReason }
	| { type: "code_execution"; request: ExecutionRequest; result: ExecutionResult }
	| { type: "validation"; result: ValidationResult }
	| { type: "sub_agent_spawn"; child_task: string; depth: number; budget: EnergyBudget }
	| { type: "budget_warning"; pressure: number; action: string };

// ---------------------------------------------------------------------------
// Task Agent Config & Result
// ---------------------------------------------------------------------------

export interface TaskAgentConfig {
	task: string;
	tools: ToolRegistry;
	policy?: RuntimePolicy;
	budget?: EnergyBudget;
	availableModels?: Model<any>[];
	model: Model<any>;
	classifierModel?: Model<any>;
	maxDepth?: number;
	maxCalls?: number;
	signal?: AbortSignal;
	priorKnowledge?: PriorKnowledge[];
	onArtifact?: (artifact: AgentArtifact) => Promise<void>;
	onEvent?: (event: TaskAgentEvent) => void;
}

export interface TaskResult {
	status: "solved" | "failed" | "aborted" | "budget_exhausted";
	solution?: unknown;
	strategies_tried: StrategyRecord[];
	total_calls: number;
	total_energy_joules: number;
	total_duration_ms: number;
	reason?: string;
}
