import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

import type { ExecutionResult, SandboxProvider } from "../types.js";

const runCodeSchema = Type.Object({
	code: Type.String({ description: "The source code to execute" }),
	language: Type.Union([Type.Literal("typescript"), Type.Literal("javascript"), Type.Literal("python")], {
		description: "The programming language of the code",
	}),
});

function formatResult(result: ExecutionResult): string {
	const parts: string[] = [];

	if (result.stdout) {
		parts.push(`--- stdout ---\n${result.stdout}`);
	}
	if (result.stderr) {
		parts.push(`--- stderr ---\n${result.stderr}`);
	}

	parts.push(
		`--- exit_code: ${result.exit_code} | duration: ${result.duration_ms}ms | timed_out: ${result.timed_out} ---`,
	);

	return parts.join("\n");
}

export function createRunCodeTool(sandbox: SandboxProvider): AgentTool<typeof runCodeSchema, undefined> {
	return {
		label: "Run Code",
		name: "run_code",
		description: "Execute code in a sandboxed environment and return the output",
		parameters: runCodeSchema,
		execute: async (_toolCallId, args) => {
			const result = await sandbox.execute({
				code: args.code,
				language: args.language,
			});

			return {
				content: [{ type: "text", text: formatResult(result) }],
				details: undefined,
			};
		},
	};
}
