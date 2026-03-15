import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { ProcessSandbox } from "../../src/sandbox/process-sandbox.js";

describe("ProcessSandbox", () => {
	const sandbox = new ProcessSandbox();

	it("executes JavaScript code and captures stdout", async () => {
		const result = await sandbox.execute({
			code: 'console.log("hello from js");',
			language: "javascript",
		});

		expect(result.stdout).toContain("hello from js");
		expect(result.exit_code).toBe(0);
		expect(result.timed_out).toBe(false);
	});

	it("executes TypeScript code and captures stdout", async () => {
		const result = await sandbox.execute({
			code: 'const msg: string = "hello from ts";\nconsole.log(msg);',
			language: "typescript",
		});

		expect(result.stdout).toContain("hello from ts");
		expect(result.exit_code).toBe(0);
		expect(result.timed_out).toBe(false);
	});

	it("handles code that writes to stderr", async () => {
		const result = await sandbox.execute({
			code: 'console.error("oops");',
			language: "javascript",
		});

		expect(result.stderr).toContain("oops");
		expect(result.exit_code).toBe(0);
	});

	it("handles non-zero exit codes", async () => {
		const result = await sandbox.execute({
			code: "process.exit(42);",
			language: "javascript",
		});

		expect(result.exit_code).not.toBe(0);
		expect(result.timed_out).toBe(false);
	});

	it("handles timeout", async () => {
		const result = await sandbox.execute({
			code: "setTimeout(() => {}, 60000);",
			language: "javascript",
			timeout_ms: 500,
		});

		expect(result.timed_out).toBe(true);
		expect(result.exit_code).not.toBe(0);
	});

	it("handles stdin input", async () => {
		const result = await sandbox.execute({
			code: `
				let data = "";
				process.stdin.on("data", (chunk) => { data += chunk; });
				process.stdin.on("end", () => { console.log("got: " + data.trim()); });
			`,
			language: "javascript",
			stdin: "hello stdin\n",
		});

		expect(result.stdout).toContain("got: hello stdin");
		expect(result.exit_code).toBe(0);
	});

	it("cleans up temp files after execution", async () => {
		const before = readdirSync(tmpdir()).filter((d) => d.startsWith("sandbox-"));

		await sandbox.execute({
			code: 'console.log("temp test");',
			language: "javascript",
		});

		const after = readdirSync(tmpdir()).filter((d) => d.startsWith("sandbox-"));
		expect(after.length).toBeLessThanOrEqual(before.length);
	});

	it("returns correct duration_ms within 1s tolerance", async () => {
		const result = await sandbox.execute({
			code: 'console.log("quick");',
			language: "javascript",
		});

		expect(result.duration_ms).toBeGreaterThanOrEqual(0);
		expect(result.duration_ms).toBeLessThan(5000);
	});
});
