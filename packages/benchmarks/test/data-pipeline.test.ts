import { describe, expect, it } from "vitest";
import { getProblemById, PIPELINE_PROBLEMS } from "../src/demos/data-pipeline/problems.js";
import type { PipelineProblem } from "../src/demos/data-pipeline/types.js";
import { validatePipelineOutput } from "../src/demos/data-pipeline/validator.js";

// ---------------------------------------------------------------------------
// Problem structure validation
// ---------------------------------------------------------------------------

describe("pipeline problems", () => {
	it("has 3 problems", () => {
		expect(PIPELINE_PROBLEMS).toHaveLength(3);
	});

	it("each problem has valid structure", () => {
		for (const p of PIPELINE_PROBLEMS) {
			expect(p.id).toBeTruthy();
			expect(p.title).toBeTruthy();
			expect(p.description).toBeTruthy();
			expect(Array.isArray(p.inputData)).toBe(true);
			expect(p.inputData.length).toBeGreaterThan(0);
			expect(Array.isArray(p.transformRules)).toBe(true);
			expect(p.transformRules.length).toBeGreaterThan(0);
			expect(Array.isArray(p.expectedOutput)).toBe(true);
			expect(p.expectedOutput.length).toBeGreaterThan(0);
			expect(["easy", "medium", "hard"]).toContain(p.difficulty);
		}
	});

	it("problems have unique IDs", () => {
		const ids = PIPELINE_PROBLEMS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("getProblemById returns correct problem", () => {
		const easy = getProblemById("pipeline-easy");
		expect(easy).toBeDefined();
		expect(easy!.difficulty).toBe("easy");
	});

	it("getProblemById returns undefined for unknown ID", () => {
		expect(getProblemById("nonexistent")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Easy problem: end-to-end transformation verification
// ---------------------------------------------------------------------------

describe("easy problem: filter and sort", () => {
	const problem = getProblemById("pipeline-easy") as PipelineProblem;

	it("has 20 input records", () => {
		expect(problem.inputData).toHaveLength(20);
	});

	it("expected output contains only West records", () => {
		for (const rec of problem.expectedOutput as Array<Record<string, unknown>>) {
			expect(rec.region).toBe("West");
		}
	});

	it("expected output is sorted by amount descending", () => {
		const output = problem.expectedOutput as Array<{ amount: number }>;
		for (let i = 1; i < output.length; i++) {
			expect(output[i - 1].amount).toBeGreaterThanOrEqual(output[i].amount);
		}
	});

	it("correct transformation produces passing result", () => {
		// Manually apply the transformation to verify end-to-end
		const input = problem.inputData as Array<{
			date: string;
			region: string;
			product: string;
			amount: number;
			quantity: number;
		}>;
		const filtered = input.filter((r) => r.region === "West");
		const sorted = filtered.sort((a, b) => b.amount - a.amount);

		const result = validatePipelineOutput(problem.expectedOutput, sorted, problem.tolerance);
		expect(result.passed).toBe(true);
		expect(result.score).toBe(1);
		expect(result.violations).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Medium problem: rolling average
// ---------------------------------------------------------------------------

describe("medium problem: rolling average", () => {
	const problem = getProblemById("pipeline-medium") as PipelineProblem;

	it("has 30 input records", () => {
		expect(problem.inputData).toHaveLength(30);
	});

	it("expected output has 30 records (one per input)", () => {
		expect(problem.expectedOutput).toHaveLength(30);
	});

	it("correct transformation produces passing result", () => {
		// Re-implement the rolling average to verify independently
		const input = problem.inputData as Array<{ date: string; region: string; value: number }>;
		const regions = [...new Set(input.map((r) => r.region))].sort();
		const result: Array<{ date: string; region: string; value: number; rolling_avg: number }> = [];

		for (const region of regions) {
			const regionRecs = input.filter((r) => r.region === region).sort((a, b) => a.date.localeCompare(b.date));
			for (let i = 0; i < regionRecs.length; i++) {
				const start = Math.max(0, i - 2);
				const window = regionRecs.slice(start, i + 1);
				const avg = window.reduce((s, r) => s + r.value, 0) / window.length;
				result.push({
					date: regionRecs[i].date,
					region,
					value: regionRecs[i].value,
					rolling_avg: Math.round(avg * 100) / 100,
				});
			}
		}

		const validation = validatePipelineOutput(problem.expectedOutput, result, problem.tolerance);
		expect(validation.passed).toBe(true);
		expect(validation.score).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Validator behavior tests
// ---------------------------------------------------------------------------

describe("validator", () => {
	it("detects wrong row count", () => {
		const expected = [{ a: 1 }, { a: 2 }, { a: 3 }];
		const actual = [{ a: 1 }, { a: 2 }];
		const result = validatePipelineOutput(expected, actual);
		expect(result.passed).toBe(false);
		expect(result.violations[0]).toContain("Expected 3 rows but got 2");
	});

	it("detects wrong field values", () => {
		const expected = [{ name: "Alice", score: 95 }];
		const actual = [{ name: "Alice", score: 80 }];
		const result = validatePipelineOutput(expected, actual);
		expect(result.passed).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]).toContain("field 'score'");
		expect(result.violations[0]).toContain("expected 95");
		expect(result.violations[0]).toContain("got 80");
	});

	it("handles floating-point tolerance", () => {
		const expected = [{ value: 142.3 }];
		const actual = [{ value: 142.305 }];

		// Within default tolerance of 0.01
		const result = validatePipelineOutput(expected, actual);
		expect(result.passed).toBe(true);

		// Outside tight tolerance
		const tight = validatePipelineOutput(expected, actual, 0.001);
		expect(tight.passed).toBe(false);
	});

	it("reports specific row/field violations", () => {
		const expected = [
			{ x: 1, y: "a" },
			{ x: 2, y: "b" },
			{ x: 3, y: "c" },
		];
		const actual = [
			{ x: 1, y: "a" },
			{ x: 2, y: "WRONG" },
			{ x: 99, y: "c" },
		];
		const result = validatePipelineOutput(expected, actual);
		expect(result.passed).toBe(false);
		expect(result.violations).toHaveLength(2);
		expect(result.violations[0]).toContain("Row 1");
		expect(result.violations[0]).toContain("field 'y'");
		expect(result.violations[1]).toContain("Row 2");
		expect(result.violations[1]).toContain("field 'x'");
	});

	it("score is proportional to matching rows", () => {
		const expected = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }];
		const actual = [{ v: 1 }, { v: 999 }, { v: 3 }, { v: 999 }];
		const result = validatePipelineOutput(expected, actual);
		expect(result.passed).toBe(false);
		expect(result.score).toBe(0.5); // 2 out of 4
	});

	it("reports missing fields", () => {
		const expected = [{ a: 1, b: 2 }];
		const actual = [{ a: 1 }];
		const result = validatePipelineOutput(expected, actual);
		expect(result.passed).toBe(false);
		expect(result.violations[0]).toContain("missing field 'b'");
	});

	it("ignores extra fields in actual", () => {
		const expected = [{ a: 1 }];
		const actual = [{ a: 1, extra: "bonus" }];
		const result = validatePipelineOutput(expected, actual);
		expect(result.passed).toBe(true);
		expect(result.score).toBe(1);
	});

	it("handles string field comparison exactly", () => {
		const expected = [{ name: "Alice" }];
		const actual = [{ name: "alice" }];
		const result = validatePipelineOutput(expected, actual);
		expect(result.passed).toBe(false);
	});

	it("handles empty arrays", () => {
		const result = validatePipelineOutput([], []);
		expect(result.passed).toBe(true);
		expect(result.score).toBe(1);
	});
});
