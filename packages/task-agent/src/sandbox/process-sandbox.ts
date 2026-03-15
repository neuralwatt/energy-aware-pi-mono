import type { ExecutionRequest, ExecutionResult, SandboxProvider } from "../types.js";

// Stub — implementation will be filled by agent
export class ProcessSandbox implements SandboxProvider {
	async execute(_request: ExecutionRequest): Promise<ExecutionResult> {
		throw new Error("Not implemented");
	}
}
