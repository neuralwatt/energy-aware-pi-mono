import { describe, expect, it } from "vitest";

import { ProcessSandbox } from "../../src/sandbox/process-sandbox.js";
import { createRunCodeTool } from "../../src/tools/run-code.js";

describe("createRunCodeTool", () => {
	const sandbox = new ProcessSandbox();
	const tool = createRunCodeTool(sandbox);

	it("creates a tool with correct name, label, and description", () => {
		expect(tool.name).toBe("run_code");
		expect(tool.label).toBe("Run Code");
		expect(tool.description).toBeTruthy();
	});

	it("executes JavaScript code via the tool interface", async () => {
		const result = await tool.execute("test-call-id", {
			code: 'console.log("tool output");',
			language: "javascript",
		});

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect(result.content[0]).toHaveProperty("text");
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("tool output");
		expect(text).toContain("exit_code: 0");
	});

	it("returns formatted output in content blocks", async () => {
		const result = await tool.execute("test-call-id", {
			code: 'console.log("out");\nconsole.error("err");',
			language: "javascript",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("--- stdout ---");
		expect(text).toContain("--- stderr ---");
		expect(text).toContain("out");
		expect(text).toContain("err");
	});

	it("handles execution errors gracefully", async () => {
		const result = await tool.execute("test-call-id", {
			code: 'throw new Error("boom");',
			language: "javascript",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("boom");
		expect(text).not.toContain("exit_code: 0");
	});
});
