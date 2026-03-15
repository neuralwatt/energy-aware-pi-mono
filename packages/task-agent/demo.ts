/**
 * Task Agent Demo Runner
 *
 * Runs an LLM agent against one of three demo problem domains:
 * - scheduling: Conference scheduling (constraint satisfaction)
 * - code-from-tests: Write code that passes a test suite (iterative refinement)
 * - data-pipeline: Data transformation synthesis (decomposition + composition)
 *
 * Usage:
 *   npx tsx demo.ts scheduling [small|medium|hard]
 *   npx tsx demo.ts code-from-tests [merge-intervals|lru-cache|longest-palindrome]
 *   npx tsx demo.ts data-pipeline [easy|medium|hard]
 *
 * Environment:
 *   NEURALWATT_API_KEY  Required
 *   DEMO_MODEL          Model ID (default: mistralai/Devstral-Small-2-24B-Instruct-2512)
 */

// @ts-nocheck — demo script, cross-package source imports bypass tsgo
import { agentLoop } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { ProcessSandbox } from "./src/sandbox/process-sandbox.js";
import { createRecordLessonTool, createRecordStrategyTool } from "./src/tools/record.js";
import { createRunCodeTool } from "./src/tools/run-code.js";
import { createValidateTool } from "./src/tools/validate.js";
import { LONGEST_PALINDROME, LRU_CACHE, MERGE_INTERVALS } from "../benchmarks/src/demos/code-from-tests/problems.js";
import { createCodeValidator } from "../benchmarks/src/demos/code-from-tests/validator.js";
import { PIPELINE_PROBLEMS } from "../benchmarks/src/demos/data-pipeline/problems.js";
import { validatePipelineOutput } from "../benchmarks/src/demos/data-pipeline/validator.js";
import { generateProblem } from "../benchmarks/src/demos/scheduling/generator.js";
import { validateSchedule } from "../benchmarks/src/demos/scheduling/validator.js";

// ---------------------------------------------------------------------------
// Terminal formatting
// ---------------------------------------------------------------------------

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function log(msg) {
	console.log(msg);
}

function logHeader(msg) {
	console.log(`\n${BOLD}${CYAN}=== ${msg} ===${RESET}\n`);
}

function logEvent(type, detail) {
	const color = type.includes("PASS") ? GREEN : type.includes("FAIL") ? RED : YELLOW;
	console.log(`  ${color}[${type}]${RESET} ${detail}`);
}

// ---------------------------------------------------------------------------
// Problem setup
// ---------------------------------------------------------------------------

function setupSchedulingProblem(difficulty) {
	const diff = difficulty || "small";
	const problem = generateProblem(diff);

	const lines = [];
	lines.push(problem.description);
	lines.push("");
	lines.push("## Talks");
	for (const t of problem.talks) {
		lines.push(`- ${t.id}: "${t.title}" by speaker ${t.speaker_id} (${t.duration_minutes}min)`);
	}
	lines.push("");
	lines.push("## Rooms");
	for (const r of problem.rooms) {
		lines.push(`- ${r.id}: "${r.name}" capacity=${r.capacity} equipment=[${r.equipment.join(", ")}]`);
	}
	lines.push("");
	lines.push("## Time Slots");
	for (const s of problem.time_slots) {
		lines.push(`- ${s.id}: ${s.start} - ${s.end}`);
	}
	lines.push("");
	lines.push("## Constraints");
	for (const c of problem.constraints) {
		lines.push(`- ${JSON.stringify(c)}`);
	}
	lines.push("");
	lines.push(
		'Your solution should be a JSON object with an "assignments" array. ' +
			"Each assignment has talk_id, room_id, and time_slot_id. " +
			"Use validate_solution to check your schedule. " +
			"Pass the JSON object (not a string) to validate_solution.",
	);

	return {
		name: `Scheduling (${diff})`,
		task: lines.join("\n"),
		validator: (solution) => {
			const schedule = typeof solution === "string" ? JSON.parse(solution) : solution;
			return validateSchedule(problem, schedule);
		},
	};
}

function setupCodeProblem(problemId) {
	const problems = {
		"merge-intervals": MERGE_INTERVALS,
		"lru-cache": LRU_CACHE,
		"longest-palindrome": LONGEST_PALINDROME,
	};
	const problem = problems[problemId || "merge-intervals"];
	if (!problem) {
		throw new Error(`Unknown code problem: ${problemId}. Choose: ${Object.keys(problems).join(", ")}`);
	}

	const sandbox = new ProcessSandbox();
	const validator = createCodeValidator(problem, sandbox);

	return {
		name: `Code from Tests: ${problem.title}`,
		task:
			`${problem.description}\n\nFunction signature: ${problem.signature}\n\n` +
			`Write the implementation. The solution will be tested against ${problem.testCount} test cases.\n` +
			"Use run_code to test your implementation, then use validate_solution with your final code as a string.",
		validator,
	};
}

function setupPipelineProblem(difficulty) {
	const diff = difficulty || "easy";
	const problem = PIPELINE_PROBLEMS.find((p) => p.difficulty === diff);
	if (!problem) {
		throw new Error(`Unknown pipeline difficulty: ${diff}`);
	}

	return {
		name: `Data Pipeline: ${problem.title}`,
		task:
			`${problem.description}\n\n` +
			`Input data (${problem.inputData.length} records):\n${JSON.stringify(problem.inputData, null, 2).substring(0, 2000)}...\n\n` +
			`Transform rules:\n${problem.transformRules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n\n` +
			"Write code that transforms the input data according to these rules. " +
			"Use run_code to execute your transformation, printing the result as JSON. " +
			"Then use validate_solution with the output array to check your result.",
		validator: (solution) => {
			const actual = Array.isArray(solution) ? solution : [];
			return validatePipelineOutput(problem.expectedOutput, actual);
		},
	};
}

// ---------------------------------------------------------------------------
// Agent runner
// ---------------------------------------------------------------------------

function defaultConvertToLlm(messages) {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

async function runDemo(demoProblem, modelId) {
	const apiKey = process.env.NEURALWATT_API_KEY;
	if (!apiKey) {
		console.error("NEURALWATT_API_KEY required");
		process.exit(1);
	}

	const model = getModel("neuralwatt", modelId);
	logHeader(`${demoProblem.name}`);
	log(`${DIM}Model: ${model.name} (${model.id})${RESET}`);
	log(`${DIM}Task preview: ${demoProblem.task.substring(0, 200)}...${RESET}`);

	// Build tools
	const sandbox = new ProcessSandbox();
	const strategies = [];

	const tools = [
		createRunCodeTool(sandbox),
		createValidateTool(demoProblem.validator),
		createRecordStrategyTool(strategies),
		createRecordLessonTool(strategies),
	];

	const systemPrompt = `You are a problem-solving agent. Your goal is to solve the following task:

${demoProblem.task}

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
- Be concise in your reasoning.`;

	const context = {
		systemPrompt,
		messages: [],
		tools,
	};

	const userMessage = {
		role: "user",
		content: [{ type: "text", text: `Solve this problem:\n\n${demoProblem.task}` }],
		timestamp: Date.now(),
	};

	const loopConfig = {
		model,
		convertToLlm: defaultConvertToLlm,
		apiKey,
		maxTokens: 4096,
	};

	const startTime = performance.now();
	let totalCalls = 0;
	let totalTokens = 0;
	let solved = false;

	log(`\n${BOLD}Starting agent loop...${RESET}\n`);

	const eventStream = agentLoop([userMessage], context, loopConfig);

	for await (const event of eventStream) {
		switch (event.type) {
			case "turn_start":
				totalCalls++;
				log(`${DIM}--- Turn ${totalCalls} ---${RESET}`);
				break;

			case "message_end":
				if (event.message.role === "assistant") {
					const msg = event.message;
					totalTokens += msg.usage?.totalTokens ?? 0;

					const textParts = msg.content.filter((c) => c.type === "text");
					for (const part of textParts) {
						if (part.text?.trim()) {
							log(`  ${DIM}Agent: ${part.text.substring(0, 300)}${part.text.length > 300 ? "..." : ""}${RESET}`);
						}
					}
				}
				break;

			case "tool_execution_start":
				log(`  ${CYAN}> ${event.toolName}${RESET}${DIM}(${JSON.stringify(event.args).substring(0, 120)})${RESET}`);
				break;

			case "tool_execution_end": {
				const resultText = event.result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("");

				if (event.toolName === "validate_solution") {
					if (resultText.includes("Passed: true")) {
						logEvent("PASS", "Validation passed!");
						solved = true;
					} else {
						logEvent("FAIL", resultText.substring(0, 200));
					}
				} else if (event.toolName === "record_strategy") {
					logEvent("STRATEGY", resultText);
				} else if (event.toolName === "record_lesson") {
					logEvent("LESSON", resultText);
				} else if (event.toolName === "run_code") {
					const preview = resultText.substring(0, 150).replace(/\n/g, " ");
					log(`    ${DIM}${preview}${resultText.length > 150 ? "..." : ""}${RESET}`);
				}
				break;
			}
		}
	}

	const durationMs = Math.round(performance.now() - startTime);

	// Print summary
	logHeader("Results");
	log(`  Status:     ${solved ? `${GREEN}SOLVED${RESET}` : `${RED}FAILED${RESET}`}`);
	log(`  Turns:      ${totalCalls}`);
	log(`  Tokens:     ${totalTokens}`);
	log(`  Duration:   ${(durationMs / 1000).toFixed(1)}s`);
	log(`  Strategies: ${strategies.length}`);
	for (const s of strategies) {
		const outcome = s.backtrack_reason ? `${RED}backtrack${RESET}` : `${GREEN}success${RESET}`;
		log(`    - ${s.strategy.name} (${s.attempts.length} attempts, ${outcome})`);
		if (s.backtrack_reason) {
			log(`      ${DIM}Lesson: ${s.backtrack_reason.lesson}${RESET}`);
		}
	}
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , domain, variant] = process.argv;
const modelId = process.env.DEMO_MODEL || "mistralai/Devstral-Small-2-24B-Instruct-2512";

if (!domain || !["scheduling", "code-from-tests", "data-pipeline"].includes(domain)) {
	console.log("Usage: npx tsx demo.ts <domain> [variant]");
	console.log("");
	console.log("Domains:");
	console.log("  scheduling      [small|medium|hard]");
	console.log("  code-from-tests [merge-intervals|lru-cache|longest-palindrome]");
	console.log("  data-pipeline   [easy|medium|hard]");
	console.log("");
	console.log("Environment:");
	console.log("  NEURALWATT_API_KEY  Required");
	console.log("  DEMO_MODEL          Model ID (default: mistralai/Devstral-Small-2-24B-Instruct-2512)");
	process.exit(1);
}

let problem;
switch (domain) {
	case "scheduling":
		problem = setupSchedulingProblem(variant);
		break;
	case "code-from-tests":
		problem = setupCodeProblem(variant);
		break;
	case "data-pipeline":
		problem = setupPipelineProblem(variant);
		break;
	default:
		throw new Error(`Unknown domain: ${domain}`);
}

runDemo(problem, modelId).catch((err) => {
	console.error("Demo failed:", err);
	process.exit(1);
});
