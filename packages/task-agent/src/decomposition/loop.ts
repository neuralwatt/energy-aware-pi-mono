import { randomUUID } from "node:crypto";
import type {
	AgentArtifact,
	Attempt,
	BacktrackReason,
	ExecutionResult,
	PriorKnowledge,
	Strategy,
	StrategyRecord,
	TaskAgentEvent,
	ValidationResult,
} from "../types.js";

export interface DecompositionLoopConfig {
	maxDepth: number;
	maxAttempts: number;
	onEvent?: (event: TaskAgentEvent) => void;
	onArtifact?: (artifact: AgentArtifact) => Promise<void>;
	priorKnowledge?: PriorKnowledge[];
}

export class DecompositionLoop {
	private readonly config: DecompositionLoopConfig;
	private readonly strategies: StrategyRecord[] = [];
	private _currentStrategy: StrategyRecord | null = null;
	private readonly lessons: BacktrackReason[] = [];
	private depth = 0;

	constructor(config?: Partial<DecompositionLoopConfig>) {
		this.config = {
			maxDepth: config?.maxDepth ?? 5,
			maxAttempts: config?.maxAttempts ?? 3,
			onEvent: config?.onEvent,
			onArtifact: config?.onArtifact,
			priorKnowledge: config?.priorKnowledge,
		};
	}

	startStrategy(name: string, approach: string, parentId?: string): Strategy {
		const parentRecord = parentId ? this.strategies.find((s) => s.strategy.id === parentId) : undefined;
		const strategyDepth = parentRecord ? parentRecord.strategy.depth + 1 : 0;

		if (strategyDepth >= this.config.maxDepth) {
			throw new Error(`Max depth ${this.config.maxDepth} exceeded`);
		}

		const strategy: Strategy = {
			id: randomUUID(),
			name,
			approach,
			parent_id: parentId,
			depth: strategyDepth,
		};

		const record: StrategyRecord = {
			strategy,
			attempts: [],
			duration_ms: 0,
			energy_joules: 0,
		};

		this._currentStrategy = record;
		this.strategies.push(record);
		this.depth = strategyDepth;

		this.emit({ type: "strategy_start", strategy });

		if (this.config.onArtifact) {
			void this.config.onArtifact({ type: "strategy", data: record });
		}

		return strategy;
	}

	recordAttempt(code: string, execution: ExecutionResult, validation: ValidationResult): Attempt {
		if (!this._currentStrategy) {
			throw new Error("No current strategy — call startStrategy first");
		}

		const attempt: Attempt = {
			strategy: this._currentStrategy.strategy,
			code,
			execution,
			validation,
		};

		this._currentStrategy.attempts.push(attempt);

		this.emit({
			type: "attempt_end",
			attempt,
		});

		return attempt;
	}

	backtrack(failureType: BacktrackReason["failure_type"], lesson: string): BacktrackReason {
		if (!this._currentStrategy) {
			throw new Error("No current strategy — call startStrategy first");
		}

		const reason: BacktrackReason = {
			strategy_id: this._currentStrategy.strategy.id,
			failure_type: failureType,
			lesson,
		};

		this.lessons.push(reason);
		this._currentStrategy.backtrack_reason = reason;

		this.emit({
			type: "strategy_end",
			strategy: this._currentStrategy.strategy,
			outcome: "backtrack",
		});

		this.emit({
			type: "backtrack",
			reason,
		});

		if (this.config.onArtifact) {
			void this.config.onArtifact({ type: "lesson", data: reason });
		}

		this._currentStrategy = null;

		return reason;
	}

	succeed(): void {
		if (!this._currentStrategy) {
			throw new Error("No current strategy — call startStrategy first");
		}

		this.emit({
			type: "strategy_end",
			strategy: this._currentStrategy.strategy,
			outcome: "success",
		});

		this._currentStrategy = null;
	}

	getLessons(): string[] {
		return this.lessons.map((l) => l.lesson);
	}

	getPriorKnowledgeSummary(): string {
		const prior = this.config.priorKnowledge;
		if (!prior || prior.length === 0) {
			return "";
		}

		const parts: string[] = [];
		for (const pk of prior) {
			parts.push(`Source: ${pk.source}`);
			parts.push(`Similarity: ${pk.problem_similarity}`);
			if (pk.lessons.length > 0) {
				parts.push(`Lessons: ${pk.lessons.join("; ")}`);
			}
			if (pk.strategies_to_avoid && pk.strategies_to_avoid.length > 0) {
				parts.push(`Avoid: ${pk.strategies_to_avoid.join(", ")}`);
			}
			if (pk.strategies_that_worked && pk.strategies_that_worked.length > 0) {
				parts.push(`Worked: ${pk.strategies_that_worked.join(", ")}`);
			}
			parts.push("");
		}

		return parts.join("\n").trim();
	}

	getStrategiesSummary(): string {
		if (this.strategies.length === 0) {
			return "";
		}

		const parts: string[] = [];
		for (const record of this.strategies) {
			const outcome = record.backtrack_reason ? "backtrack" : "success";
			parts.push(`Strategy: ${record.strategy.name} (${outcome})`);
			parts.push(`  Approach: ${record.strategy.approach}`);
			parts.push(`  Attempts: ${record.attempts.length}`);
			if (record.backtrack_reason) {
				parts.push(`  Lesson: ${record.backtrack_reason.lesson}`);
			}
		}

		return parts.join("\n");
	}

	canContinue(): boolean {
		if (this.depth >= this.config.maxDepth) {
			return false;
		}
		if (this._currentStrategy && this._currentStrategy.attempts.length >= this.config.maxAttempts) {
			return false;
		}
		return true;
	}

	getResults(): StrategyRecord[] {
		return this.strategies.map((r) => ({ ...r, attempts: [...r.attempts] }));
	}

	get currentDepth(): number {
		return this.depth;
	}

	get totalAttempts(): number {
		return this.strategies.reduce((sum, r) => sum + r.attempts.length, 0);
	}

	get strategiesCount(): number {
		return this.strategies.length;
	}

	get currentStrategy(): StrategyRecord | null {
		return this._currentStrategy;
	}

	private emit(event: TaskAgentEvent): void {
		if (this.config.onEvent) {
			this.config.onEvent(event);
		}
	}
}
