import type { AgentContext, AgentLoopConfig, AgentMessage } from "@mariozechner/pi-agent-core";
import { agentLoop } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { DecompositionLoop } from "./decomposition/loop.js";
import type { TaskAgentConfig, TaskAgentEvent, TaskResult } from "./types.js";

function buildSystemPrompt(config: TaskAgentConfig, decomp: DecompositionLoop): string {
	const parts: string[] = [];

	parts.push(`You are a problem-solving agent. Your goal is to solve the following task:

${config.task}

You have access to tools for executing code, validating solutions, and recording your problem-solving process.`);

	parts.push(`
## Problem-Solving Process

Follow this cycle:
1. **Record your strategy** using record_strategy before attempting a solution.
2. **Write and run code** using run_code to implement your strategy.
3. **Validate your solution** using validate_solution.
4. If validation fails, **analyze the failure**, then either:
   a. Fix the code and try again (if the approach is sound but has bugs), OR
   b. **Record a lesson** using record_lesson and try a completely different strategy.
5. Repeat until the solution passes validation or you exhaust your options.

## Rules
- Always call record_strategy BEFORE writing any code for a new approach.
- Always call validate_solution to check your work — do not assume correctness.
- When a strategy fundamentally fails (not just a bug), call record_lesson to capture what you learned.
- Use lessons from failed strategies to inform your next approach.
- Be concise in your reasoning. Focus on solving the problem, not explaining your thought process at length.`);

	const priorSummary = decomp.getPriorKnowledgeSummary();
	if (priorSummary) {
		parts.push(`
## Prior Knowledge
The following lessons from prior problem-solving sessions may be relevant:

${priorSummary}`);
	}

	const strategiesSummary = decomp.getStrategiesSummary();
	if (strategiesSummary) {
		parts.push(`
## Previous Attempts (this session)
${strategiesSummary}`);
	}

	return parts.join("\n");
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

export class TaskAgent {
	private readonly config: TaskAgentConfig;

	constructor(config: TaskAgentConfig) {
		this.config = config;
	}

	async *run(): AsyncGenerator<TaskAgentEvent, TaskResult> {
		const config = this.config;
		const startTime = performance.now();
		let totalCalls = 0;
		let totalEnergy = 0;
		const maxCalls = config.maxCalls ?? 50;

		const decomp = new DecompositionLoop({
			maxDepth: config.maxDepth ?? 5,
			maxAttempts: 3,
			onEvent: config.onEvent,
			onArtifact: config.onArtifact,
			priorKnowledge: config.priorKnowledge,
		});

		yield { type: "task_start", task: config.task };

		const tools = config.tools.list();
		const systemPrompt = buildSystemPrompt(config, decomp);

		const context: AgentContext = {
			systemPrompt,
			messages: [],
			tools,
		};

		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: `Solve this problem:\n\n${config.task}` }],
			timestamp: Date.now(),
		};

		const loopConfig: AgentLoopConfig = {
			model: config.model,
			convertToLlm: defaultConvertToLlm,
			policy: config.policy,
			budget: config.budget,
			availableModels: config.availableModels,
		};

		const eventStream = agentLoop([userMessage], context, loopConfig, config.signal);

		for await (const event of eventStream) {
			// Track LLM calls for the max call limit
			if (event.type === "message_end" && event.message.role === "assistant") {
				totalCalls++;
				const msg = event.message as AssistantMessage;

				if (msg.energy?.energy_joules != null) {
					totalEnergy += msg.energy.energy_joules;
				}

				// Check max calls
				if (totalCalls >= maxCalls) {
					const result: TaskResult = {
						status: "failed",
						strategies_tried: decomp.getResults(),
						total_calls: totalCalls,
						total_energy_joules: totalEnergy,
						total_duration_ms: Math.round(performance.now() - startTime),
						reason: `Max LLM calls (${maxCalls}) reached`,
					};
					yield { type: "task_end", result };
					return result;
				}
			}

			// Check for abort from policy
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				(event.message as AssistantMessage).stopReason === "aborted"
			) {
				const result: TaskResult = {
					status: "budget_exhausted",
					strategies_tried: decomp.getResults(),
					total_calls: totalCalls,
					total_energy_joules: totalEnergy,
					total_duration_ms: Math.round(performance.now() - startTime),
					reason: "Budget exhausted by energy policy",
				};
				yield { type: "task_end", result };
				return result;
			}
		}

		// The agent loop completed. Determine outcome from the decomposition state.
		const strategies = decomp.getResults();
		const lastSuccessful = strategies.find((s) => !s.backtrack_reason && s.attempts.length > 0);
		const lastAttempt = lastSuccessful?.attempts[lastSuccessful.attempts.length - 1];
		const solved = lastAttempt?.validation?.passed === true;

		const result: TaskResult = {
			status: solved ? "solved" : "failed",
			solution: solved ? (lastAttempt?.validation?.details ?? lastAttempt?.code) : undefined,
			strategies_tried: strategies,
			total_calls: totalCalls,
			total_energy_joules: totalEnergy,
			total_duration_ms: Math.round(performance.now() - startTime),
			reason: solved ? undefined : "Agent completed without finding a valid solution",
		};

		if (config.onArtifact && solved && lastAttempt) {
			await config.onArtifact({
				type: "solution",
				data: { solution: lastAttempt.code, validation: lastAttempt.validation },
			});
		}

		yield { type: "task_end", result };
		return result;
	}
}
