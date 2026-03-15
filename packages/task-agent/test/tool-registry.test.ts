import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tool-registry.js";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: `Label for ${name}`,
		description: `Description for ${name}`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
	};
}

describe("ToolRegistry", () => {
	it("register() adds a tool", () => {
		const registry = new ToolRegistry();
		const tool = makeTool("test_tool");
		registry.register(tool);
		expect(registry.size()).toBe(1);
	});

	it("get() retrieves a registered tool", () => {
		const registry = new ToolRegistry();
		const tool = makeTool("test_tool");
		registry.register(tool);
		expect(registry.get("test_tool")).toBe(tool);
	});

	it("get() returns undefined for unknown tools", () => {
		const registry = new ToolRegistry();
		expect(registry.get("nonexistent")).toBeUndefined();
	});

	it("has() checks tool existence", () => {
		const registry = new ToolRegistry();
		const tool = makeTool("test_tool");
		registry.register(tool);
		expect(registry.has("test_tool")).toBe(true);
		expect(registry.has("nonexistent")).toBe(false);
	});

	it("unregister() removes a tool", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool("test_tool"));
		registry.unregister("test_tool");
		expect(registry.has("test_tool")).toBe(false);
		expect(registry.size()).toBe(0);
	});

	it("list() returns all tools", () => {
		const registry = new ToolRegistry();
		const a = makeTool("a");
		const b = makeTool("b");
		registry.register(a);
		registry.register(b);
		expect(registry.list()).toEqual([a, b]);
	});

	it("names() returns all tool names", () => {
		const registry = new ToolRegistry();
		registry.register(makeTool("alpha"));
		registry.register(makeTool("beta"));
		expect(registry.names()).toEqual(["alpha", "beta"]);
	});

	it("size() returns tool count", () => {
		const registry = new ToolRegistry();
		expect(registry.size()).toBe(0);
		registry.register(makeTool("a"));
		registry.register(makeTool("b"));
		registry.register(makeTool("c"));
		expect(registry.size()).toBe(3);
	});

	it("merge() combines two registries", () => {
		const r1 = new ToolRegistry();
		const r2 = new ToolRegistry();
		r1.register(makeTool("a"));
		r2.register(makeTool("b"));
		const merged = r1.merge(r2);
		expect(merged.size()).toBe(2);
		expect(merged.has("a")).toBe(true);
		expect(merged.has("b")).toBe(true);
	});

	it("merge() overwrites tools with same name (second registry wins)", () => {
		const r1 = new ToolRegistry();
		const r2 = new ToolRegistry();
		const toolV1 = makeTool("shared");
		const toolV2 = makeTool("shared");
		r1.register(toolV1);
		r2.register(toolV2);
		const merged = r1.merge(r2);
		expect(merged.get("shared")).toBe(toolV2);
		expect(merged.get("shared")).not.toBe(toolV1);
	});
});
