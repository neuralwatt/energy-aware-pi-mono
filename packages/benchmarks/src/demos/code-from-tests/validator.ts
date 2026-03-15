import type { CodeProblem, SandboxProvider, ValidationResult } from "./types.js";

/** Parse PASS/FAIL lines from sandbox stdout. */
export function parseTestOutput(stdout: string): { passed: string[]; failed: string[]; total: number } {
	const lines = stdout.split("\n");
	const passed: string[] = [];
	const failed: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("PASS: ")) {
			passed.push(trimmed.slice(6));
		} else if (trimmed.startsWith("FAIL: ")) {
			// Extract just the test name (before any ": details")
			const rest = trimmed.slice(6);
			const colonIdx = rest.indexOf(": ");
			const name = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
			failed.push(name);
		}
	}

	// Try to extract total from summary line like "8/10 tests passed"
	const summaryMatch = stdout.match(/(\d+)\/(\d+) tests passed/);
	const total = summaryMatch ? parseInt(summaryMatch[2], 10) : passed.length + failed.length;

	return { passed, failed, total };
}

/**
 * Create a validator for a code-from-tests problem.
 * The returned function accepts a solution code string, prepends it to the test code,
 * runs the combined file in the sandbox, and returns a ValidationResult.
 */
export function createCodeValidator(
	problem: CodeProblem,
	sandbox: SandboxProvider,
): (solution: unknown) => Promise<ValidationResult> {
	return async (solution: unknown): Promise<ValidationResult> => {
		if (typeof solution !== "string") {
			return {
				passed: false,
				score: 0,
				violations: ["Solution must be a string of TypeScript code"],
			};
		}

		const combinedCode = `${solution}\n\n${problem.testCode}`;

		const execution = await sandbox.execute({
			code: combinedCode,
			language: "typescript",
			timeout_ms: 30_000,
		});

		if (execution.timed_out) {
			return {
				passed: false,
				score: 0,
				violations: ["Execution timed out"],
				details: { stderr: execution.stderr },
			};
		}

		if (execution.exit_code !== 0 && !execution.stdout.includes("PASS:") && !execution.stdout.includes("FAIL:")) {
			return {
				passed: false,
				score: 0,
				violations: [`Execution failed: ${execution.stderr || `exit code ${execution.exit_code}`}`],
				details: { stderr: execution.stderr, exit_code: execution.exit_code },
			};
		}

		const { passed, failed, total } = parseTestOutput(execution.stdout);
		const effectiveTotal = total > 0 ? total : problem.testCount;
		const score = effectiveTotal > 0 ? passed.length / effectiveTotal : 0;

		return {
			passed: failed.length === 0 && passed.length > 0,
			score,
			violations: failed,
			details: {
				passed_tests: passed,
				failed_tests: failed,
				total,
				stdout: execution.stdout,
				stderr: execution.stderr,
			},
		};
	};
}
