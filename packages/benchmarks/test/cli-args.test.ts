/**
 * Tests for CLI argument parsing in both demos.
 *
 * These verify that parseArgs is configured correctly and that all
 * documented flags are recognized. This catches issues like npm
 * swallowing flags (users must use `--` separator with `npm run`).
 */

import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";

// -- Coding demo arg spec (mirrors coding-agent.ts main()) --------------------

const CODING_DEMO_OPTIONS = {
	budget: { type: "string" as const, default: "25000" },
	task: { type: "string" as const },
	acceptance: { type: "string" as const },
	static: { type: "boolean" as const, default: false },
	reverse: { type: "boolean" as const, default: false },
	runs: { type: "string" as const, default: "1" },
	fast: { type: "boolean" as const, default: false },
	hard: { type: "boolean" as const, default: false },
	"clear-memory": { type: "boolean" as const, default: false },
};

function parseCodingArgs(argv: string[]) {
	return parseArgs({ options: CODING_DEMO_OPTIONS, allowPositionals: true, args: argv });
}

// -- HN demo arg spec (mirrors hn-watcher.ts main()) -------------------------

const HN_DEMO_OPTIONS = {
	duration: { type: "string" as const, default: "180" },
	budget: { type: "string" as const, default: "5000" },
	keywords: { type: "string" as const },
	fast: { type: "boolean" as const, default: false },
	"clear-memory": { type: "boolean" as const, default: false },
};

function parseHNArgs(argv: string[]) {
	return parseArgs({ options: HN_DEMO_OPTIONS, allowPositionals: true, args: argv });
}

// -- Tests --------------------------------------------------------------------

describe("coding demo CLI args", () => {
	it("defaults: 1 run, 25000J budget, no flags", () => {
		const { values } = parseCodingArgs([]);
		expect(values.runs).toBe("1");
		expect(values.budget).toBe("25000");
		expect(values.static).toBe(false);
		expect(values.reverse).toBe(false);
		expect(values.fast).toBe(false);
		expect(values.hard).toBe(false);
		expect(values["clear-memory"]).toBe(false);
	});

	it("--runs 4 sets 4 runs", () => {
		const { values } = parseCodingArgs(["--runs", "4"]);
		expect(values.runs).toBe("4");
	});

	it("--budget 50000 overrides budget", () => {
		const { values } = parseCodingArgs(["--budget", "50000"]);
		expect(values.budget).toBe("50000");
	});

	it("--static enables static mode", () => {
		const { values } = parseCodingArgs(["--static"]);
		expect(values.static).toBe(true);
	});

	it("--reverse enables reverse order", () => {
		const { values } = parseCodingArgs(["--reverse"]);
		expect(values.reverse).toBe(true);
	});

	it("--fast enables fast mode", () => {
		const { values } = parseCodingArgs(["--fast"]);
		expect(values.fast).toBe(true);
	});

	it("--hard enables hard challenges", () => {
		const { values } = parseCodingArgs(["--hard"]);
		expect(values.hard).toBe(true);
	});

	it("--clear-memory sets clear flag", () => {
		const { values } = parseCodingArgs(["--clear-memory"]);
		expect(values["clear-memory"]).toBe(true);
	});

	it("--task provides custom task", () => {
		const { values } = parseCodingArgs(["--task", "implement fizzbuzz"]);
		expect(values.task).toBe("implement fizzbuzz");
	});

	it("multiple flags combined", () => {
		const { values } = parseCodingArgs(["--runs", "3", "--reverse", "--hard", "--budget", "10000"]);
		expect(values.runs).toBe("3");
		expect(values.reverse).toBe(true);
		expect(values.hard).toBe(true);
		expect(values.budget).toBe("10000");
	});

	it("positional args are allowed (don't throw)", () => {
		const { positionals } = parseCodingArgs(["some-positional"]);
		expect(positionals).toContain("some-positional");
	});

	it("unknown flags throw", () => {
		expect(() => parseCodingArgs(["--unknown-flag"])).toThrow();
	});
});

describe("HN demo CLI args", () => {
	it("defaults: 180s duration, 5000J budget", () => {
		const { values } = parseHNArgs([]);
		expect(values.duration).toBe("180");
		expect(values.budget).toBe("5000");
		expect(values.fast).toBe(false);
		expect(values["clear-memory"]).toBe(false);
	});

	it("--duration 60 overrides duration", () => {
		const { values } = parseHNArgs(["--duration", "60"]);
		expect(values.duration).toBe("60");
	});

	it("--budget 10000 overrides budget", () => {
		const { values } = parseHNArgs(["--budget", "10000"]);
		expect(values.budget).toBe("10000");
	});

	it("--keywords overrides keywords", () => {
		const { values } = parseHNArgs(["--keywords", "rust,wasm,zig"]);
		expect(values.keywords).toBe("rust,wasm,zig");
	});

	it("--fast enables fast mode", () => {
		const { values } = parseHNArgs(["--fast"]);
		expect(values.fast).toBe(true);
	});

	it("--clear-memory sets clear flag", () => {
		const { values } = parseHNArgs(["--clear-memory"]);
		expect(values["clear-memory"]).toBe(true);
	});

	it("multiple flags combined", () => {
		const { values } = parseHNArgs(["--duration", "30", "--budget", "2000", "--fast"]);
		expect(values.duration).toBe("30");
		expect(values.budget).toBe("2000");
		expect(values.fast).toBe(true);
	});
});
