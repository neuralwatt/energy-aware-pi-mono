import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { Validator } from "../types.js";

const validateSchema = Type.Object({
	solution: Type.Unknown({ description: "The solution to validate" }),
});

export function createValidateTool(validator: Validator): AgentTool<typeof validateSchema, undefined> {
	return {
		name: "validate_solution",
		label: "Validate Solution",
		description: "Validate a proposed solution against the acceptance criteria",
		parameters: validateSchema,
		execute: async (_toolCallId, args) => {
			const result = await validator(args.solution);

			const lines: string[] = [];
			lines.push(`Passed: ${result.passed}`);
			if (result.score !== undefined) {
				lines.push(`Score: ${result.score}`);
			}
			if (result.violations.length > 0) {
				lines.push(`Violations:`);
				for (const v of result.violations) {
					lines.push(`  - ${v}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: undefined,
			};
		},
	};
}
