import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	CODE_PROBLEMS,
	createCodeValidator,
	LONGEST_PALINDROME,
	LRU_CACHE,
	MERGE_INTERVALS,
	parseTestOutput,
} from "../src/demos/code-from-tests/index.js";
import type { ExecutionResult, SandboxProvider } from "../src/demos/code-from-tests/types.js";

// ---------------------------------------------------------------------------
// Inline ProcessSandbox (task-agent is not available in this worktree)
// ---------------------------------------------------------------------------

class ProcessSandbox implements SandboxProvider {
	async execute(request: {
		code: string;
		language: "typescript" | "python" | "javascript";
		timeout_ms?: number;
	}): Promise<ExecutionResult> {
		const { code, language, timeout_ms = 30_000 } = request;
		const extMap = { typescript: ".ts", javascript: ".js", python: ".py" } as const;
		const tempDir = await mkdtemp(join(tmpdir(), "sandbox-"));
		const filePath = join(tempDir, `script${extMap[language]}`);
		await writeFile(filePath, code, "utf-8");

		try {
			return await this.run(filePath, language, timeout_ms);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	private run(
		filePath: string,
		language: "typescript" | "python" | "javascript",
		timeoutMs: number,
	): Promise<ExecutionResult> {
		const cmdMap: Record<string, [string, string[]]> = {
			typescript: ["npx", ["tsx", filePath]],
			javascript: ["node", [filePath]],
			python: ["python3", [filePath]],
		};
		const [cmd, args] = cmdMap[language];
		const start = performance.now();

		return new Promise<ExecutionResult>((resolve) => {
			execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
				const duration_ms = Math.round(performance.now() - start);
				const timed_out = error !== null && "killed" in error && error.killed === true;
				let exit_code = 0;
				if (error !== null) {
					if ("code" in error && typeof error.code === "number") {
						exit_code = error.code;
					} else if (timed_out) {
						exit_code = 124;
					} else {
						exit_code = 1;
					}
				}
				resolve({ stdout: String(stdout), stderr: String(stderr), exit_code, duration_ms, timed_out });
			});
		});
	}
}

// ---------------------------------------------------------------------------
// Correct solutions for end-to-end tests
// ---------------------------------------------------------------------------

const MERGE_INTERVALS_SOLUTION = `
function mergeIntervals(intervals: number[][]): number[][] {
	if (intervals.length === 0) return [];
	intervals.sort((a, b) => a[0] - b[0]);
	const merged: number[][] = [intervals[0]];
	for (let i = 1; i < intervals.length; i++) {
		const last = merged[merged.length - 1];
		if (intervals[i][0] <= last[1]) {
			last[1] = Math.max(last[1], intervals[i][1]);
		} else {
			merged.push(intervals[i]);
		}
	}
	return merged;
}
`;

const LRU_CACHE_SOLUTION = `
class LRUCache {
	private capacity: number;
	private cache: Map<number, number>;

	constructor(capacity: number) {
		this.capacity = capacity;
		this.cache = new Map();
	}

	get(key: number): number {
		if (!this.cache.has(key)) return -1;
		const value = this.cache.get(key)!;
		this.cache.delete(key);
		this.cache.set(key, value);
		return value;
	}

	put(key: number, value: number): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.capacity) {
			const firstKey = this.cache.keys().next().value!;
			this.cache.delete(firstKey);
		}
		this.cache.set(key, value);
	}
}
`;

const LONGEST_PALINDROME_SOLUTION = `
function longestPalindrome(s: string): string {
	if (s.length <= 1) return s;
	let start = 0;
	let maxLen = 1;

	function expandAroundCenter(left: number, right: number): void {
		while (left >= 0 && right < s.length && s[left] === s[right]) {
			const len = right - left + 1;
			if (len > maxLen) {
				start = left;
				maxLen = len;
			}
			left--;
			right++;
		}
	}

	for (let i = 0; i < s.length; i++) {
		expandAroundCenter(i, i);
		expandAroundCenter(i, i + 1);
	}

	return s.slice(start, start + maxLen);
}
`;

const WRONG_SOLUTION = `
function mergeIntervals(intervals: number[][]): number[][] {
	return intervals;
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("code-from-tests problems", () => {
	it("has 3 problems", () => {
		expect(CODE_PROBLEMS).toHaveLength(3);
	});

	it("each problem has valid structure", () => {
		for (const problem of CODE_PROBLEMS) {
			expect(problem.id).toBeTruthy();
			expect(problem.title).toBeTruthy();
			expect(problem.description).toBeTruthy();
			expect(problem.signature).toBeTruthy();
			expect(problem.testCode).toBeTruthy();
			expect(problem.testCount).toBeGreaterThan(0);
			expect(["easy", "medium", "hard"]).toContain(problem.difficulty);
		}
	});

	it("each problem has unique id", () => {
		const ids = CODE_PROBLEMS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("test code contains assert calls", () => {
		for (const problem of CODE_PROBLEMS) {
			expect(problem.testCode).toContain("function assert(");
			expect(problem.testCode).toContain("tests passed");
		}
	});

	it("difficulties span easy/medium/hard", () => {
		expect(MERGE_INTERVALS.difficulty).toBe("easy");
		expect(LRU_CACHE.difficulty).toBe("medium");
		expect(LONGEST_PALINDROME.difficulty).toBe("hard");
	});
});

describe("parseTestOutput", () => {
	it("parses all-pass output", () => {
		const stdout = ["PASS: test one", "PASS: test two", "2/2 tests passed"].join("\n");
		const result = parseTestOutput(stdout);
		expect(result.passed).toEqual(["test one", "test two"]);
		expect(result.failed).toEqual([]);
		expect(result.total).toBe(2);
	});

	it("parses mixed pass/fail output", () => {
		const stdout = [
			"PASS: alpha",
			"FAIL: beta: expected 5 got 3",
			"PASS: gamma",
			"FAIL: delta",
			"2/4 tests passed",
		].join("\n");
		const result = parseTestOutput(stdout);
		expect(result.passed).toEqual(["alpha", "gamma"]);
		expect(result.failed).toEqual(["beta", "delta"]);
		expect(result.total).toBe(4);
	});

	it("parses all-fail output", () => {
		const stdout = ["FAIL: a: wrong", "FAIL: b: also wrong", "0/2 tests passed"].join("\n");
		const result = parseTestOutput(stdout);
		expect(result.passed).toEqual([]);
		expect(result.failed).toEqual(["a", "b"]);
		expect(result.total).toBe(2);
	});

	it("handles empty output", () => {
		const result = parseTestOutput("");
		expect(result.passed).toEqual([]);
		expect(result.failed).toEqual([]);
		expect(result.total).toBe(0);
	});

	it("returns correct score calculation inputs", () => {
		const stdout = "PASS: a\nPASS: b\nFAIL: c\n2/3 tests passed";
		const result = parseTestOutput(stdout);
		expect(result.passed.length).toBe(2);
		expect(result.failed.length).toBe(1);
		expect(result.total).toBe(3);
	});
});

describe("createCodeValidator", () => {
	const sandbox = new ProcessSandbox();

	it("rejects non-string solutions", async () => {
		const validate = createCodeValidator(MERGE_INTERVALS, sandbox);
		const result = await validate(42);
		expect(result.passed).toBe(false);
		expect(result.score).toBe(0);
		expect(result.violations).toContain("Solution must be a string of TypeScript code");
	});

	it("returns full score for correct merge-intervals solution", async () => {
		const validate = createCodeValidator(MERGE_INTERVALS, sandbox);
		const result = await validate(MERGE_INTERVALS_SOLUTION);
		expect(result.passed).toBe(true);
		expect(result.score).toBe(1);
		expect(result.violations).toHaveLength(0);
	}, 30_000);

	it("returns full score for correct lru-cache solution", async () => {
		const validate = createCodeValidator(LRU_CACHE, sandbox);
		const result = await validate(LRU_CACHE_SOLUTION);
		expect(result.passed).toBe(true);
		expect(result.score).toBe(1);
		expect(result.violations).toHaveLength(0);
	}, 30_000);

	it("returns full score for correct longest-palindrome solution", async () => {
		const validate = createCodeValidator(LONGEST_PALINDROME, sandbox);
		const result = await validate(LONGEST_PALINDROME_SOLUTION);
		expect(result.passed).toBe(true);
		expect(result.score).toBe(1);
		expect(result.violations).toHaveLength(0);
	}, 30_000);

	it("returns partial score for wrong merge-intervals solution", async () => {
		const validate = createCodeValidator(MERGE_INTERVALS, sandbox);
		const result = await validate(WRONG_SOLUTION);
		expect(result.passed).toBe(false);
		expect(result.score).toBeGreaterThan(0);
		expect(result.score).toBeLessThan(1);
		expect(result.violations.length).toBeGreaterThan(0);
	}, 30_000);

	it("returns zero score for solution that causes runtime error", async () => {
		const validate = createCodeValidator(MERGE_INTERVALS, sandbox);
		const result = await validate("const mergeIntervals = null;");
		expect(result.passed).toBe(false);
		expect(result.violations.length).toBeGreaterThan(0);
	}, 30_000);
});
