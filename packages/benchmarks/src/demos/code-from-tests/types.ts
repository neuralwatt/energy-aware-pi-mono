export interface CodeProblem {
	id: string;
	title: string;
	description: string;
	signature: string;
	testCode: string;
	testCount: number;
	difficulty: "easy" | "medium" | "hard";
}

export interface ValidationResult {
	passed: boolean;
	/** 0-1, for partial credit (e.g. 7/10 tests passing = 0.7) */
	score?: number;
	violations: string[];
	details?: unknown;
}

export interface ExecutionResult {
	stdout: string;
	stderr: string;
	exit_code: number;
	duration_ms: number;
	timed_out: boolean;
}

export interface SandboxProvider {
	execute(request: {
		code: string;
		language: "typescript" | "python" | "javascript";
		timeout_ms?: number;
	}): Promise<ExecutionResult>;
}
