import { describe, expect, it, vi } from "vitest";
import { createValidateTool } from "../../src/tools/validate.js";
import type { Validator } from "../../src/types.js";

describe("createValidateTool", () => {
	it("creates tool with correct name and label", () => {
		const validator: Validator = () => ({ passed: true, violations: [] });
		const tool = createValidateTool(validator);
		expect(tool.name).toBe("validate_solution");
		expect(tool.label).toBe("Validate Solution");
	});

	it("calls the validator with the solution argument", async () => {
		const validator = vi.fn<Validator>().mockReturnValue({ passed: true, violations: [] });
		const tool = createValidateTool(validator);
		const solution = { code: "console.log('hello')" };
		await tool.execute("call-1", { solution });
		expect(validator).toHaveBeenCalledWith(solution);
	});

	it("returns pass result with violations", async () => {
		const validator: Validator = () => ({
			passed: false,
			violations: ["Missing semicolon", "Unused variable"],
		});
		const tool = createValidateTool(validator);
		const result = await tool.execute("call-1", { solution: "bad code" });
		const text = result.content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") {
			expect(text.text).toContain("Passed: false");
			expect(text.text).toContain("Missing semicolon");
			expect(text.text).toContain("Unused variable");
		}
	});

	it("handles async validators", async () => {
		const validator: Validator = async (solution) => {
			return { passed: true, violations: [], details: { checked: solution } };
		};
		const tool = createValidateTool(validator);
		const result = await tool.execute("call-1", { solution: 42 });
		const text = result.content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") {
			expect(text.text).toContain("Passed: true");
		}
	});

	it("handles validator that returns partial scores", async () => {
		const validator: Validator = () => ({
			passed: false,
			score: 0.7,
			violations: ["3 of 10 tests failed"],
		});
		const tool = createValidateTool(validator);
		const result = await tool.execute("call-1", { solution: "partial" });
		const text = result.content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") {
			expect(text.text).toContain("Score: 0.7");
			expect(text.text).toContain("3 of 10 tests failed");
		}
	});
});
