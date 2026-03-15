import type { AgentTool } from "@mariozechner/pi-agent-core";

/**
 * Composable tool collection. Each task agent instance gets its own registry.
 * Consumers register domain-specific tools alongside builtins.
 */
export class ToolRegistry {
	private tools: Map<string, AgentTool<any>> = new Map();

	register(tool: AgentTool<any>): void {
		this.tools.set(tool.name, tool);
	}

	unregister(name: string): void {
		this.tools.delete(name);
	}

	get(name: string): AgentTool<any> | undefined {
		return this.tools.get(name);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	list(): AgentTool<any>[] {
		return [...this.tools.values()];
	}

	names(): string[] {
		return [...this.tools.keys()];
	}

	size(): number {
		return this.tools.size;
	}

	/** Create a new registry that contains tools from both this and other. */
	merge(other: ToolRegistry): ToolRegistry {
		const merged = new ToolRegistry();
		for (const tool of this.tools.values()) {
			merged.register(tool);
		}
		for (const tool of other.tools.values()) {
			merged.register(tool);
		}
		return merged;
	}
}
