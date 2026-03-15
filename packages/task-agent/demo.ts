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

const B = "\x1b[1m";
const D = "\x1b[2m";
const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const M = "\x1b[35m";
const W = "\x1b[37m";
const X = "\x1b[0m";

// Box-drawing characters for the strategy tree
const VERT = "\u2502";   // |
const BRANCH = "\u251c";  // |-
const CORNER = "\u2514";  // L
const HORIZ = "\u2500";   // -
const DOT = "\u25cf";     // filled circle
const RING = "\u25cb";    // empty circle
const ARROW = "\u2192";   // ->
const CHECK = "\u2714";   // checkmark
const CROSS = "\u2718";   // X

function boxTop(title) {
	const w = 70;
	const pad = Math.max(0, w - title.length - 4);
	return `${C}${"\u250c"}${"\u2500".repeat(2)} ${B}${title}${X}${C} ${"\u2500".repeat(pad)}${"\u2510"}${X}`;
}

function boxMid(text) {
	const w = 70;
	const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
	const pad = Math.max(0, w - visible.length - 2);
	return `${C}${VERT}${X} ${text}${" ".repeat(pad)}${C}${VERT}${X}`;
}

function boxBot() {
	return `${C}${"\u2514"}${"\u2500".repeat(71)}${"\u2518"}${X}`;
}

// ---------------------------------------------------------------------------
// Strategy tree renderer
// ---------------------------------------------------------------------------

class StrategyTree {
	constructor() {
		this.strategies = [];
		this.currentIdx = -1;
		this.validationCount = 0;
		this.codeRunCount = 0;
	}

	startStrategy(name, approach) {
		this.currentIdx = this.strategies.length;
		this.strategies.push({
			name,
			approach,
			attempts: [],
			outcome: null,
			lesson: null,
		});
		this._renderStrategyStart();
	}

	recordAttempt(passed, score, violations) {
		if (this.currentIdx < 0) return;
		const s = this.strategies[this.currentIdx];
		s.attempts.push({ passed, score, violations });
		this._renderAttempt(s);
	}

	recordLesson(lesson) {
		if (this.currentIdx < 0) return;
		const s = this.strategies[this.currentIdx];
		s.outcome = "backtrack";
		s.lesson = lesson;
		this._renderBacktrack(s);
	}

	markSuccess() {
		if (this.currentIdx < 0) return;
		this.strategies[this.currentIdx].outcome = "success";
		this._renderSuccess();
	}

	recordCodeRun() {
		this.codeRunCount++;
	}

	_indent() {
		const depth = this.currentIdx;
		return "  ".repeat(Math.min(depth, 3));
	}

	_renderStrategyStart() {
		const s = this.strategies[this.currentIdx];
		const num = this.currentIdx + 1;
		const indent = this._indent();
		console.log("");
		console.log(`${indent}${C}${DOT}${X} ${B}Strategy #${num}: ${s.name}${X}`);
		console.log(`${indent}${C}${VERT}${X} ${D}${s.approach.substring(0, 100)}${s.approach.length > 100 ? "..." : ""}${X}`);
	}

	_renderAttempt(s) {
		const indent = this._indent();
		const attemptNum = s.attempts.length;
		const a = s.attempts[attemptNum - 1];
		const icon = a.passed ? `${G}${CHECK}${X}` : `${R}${CROSS}${X}`;
		const scoreStr = a.score != null ? ` score=${(a.score * 100).toFixed(0)}%` : "";

		console.log(`${indent}${C}${VERT}${X}`);
		console.log(`${indent}${C}${BRANCH}${HORIZ}${X} ${icon} Attempt #${attemptNum}${scoreStr}`);

		if (!a.passed && a.violations?.length > 0) {
			const maxShow = 3;
			for (let i = 0; i < Math.min(a.violations.length, maxShow); i++) {
				const v = a.violations[i];
				const prefix = i < Math.min(a.violations.length, maxShow) - 1 ? BRANCH : CORNER;
				console.log(`${indent}${C}${VERT}${X}   ${D}${prefix}${HORIZ} ${v.substring(0, 80)}${X}`);
			}
			if (a.violations.length > maxShow) {
				console.log(`${indent}${C}${VERT}${X}   ${D}  ...and ${a.violations.length - maxShow} more violations${X}`);
			}
		}
	}

	_renderBacktrack(s) {
		const indent = this._indent();
		console.log(`${indent}${C}${VERT}${X}`);
		console.log(`${indent}${C}${CORNER}${HORIZ}${X} ${R}${B}BACKTRACK${X} ${R}${ARROW}${X} ${Y}${s.lesson?.substring(0, 100)}${X}`);
	}

	_renderSuccess() {
		const indent = this._indent();
		console.log(`${indent}${C}${VERT}${X}`);
		console.log(`${indent}${C}${CORNER}${HORIZ}${X} ${G}${B}SOLVED ${CHECK}${X}`);
	}

	renderSummary(totalCalls, totalTokens, durationMs) {
		console.log("");
		console.log(boxTop("Strategy Tree"));
		for (let i = 0; i < this.strategies.length; i++) {
			const s = this.strategies[i];
			const isLast = i === this.strategies.length - 1;
			const prefix = isLast ? CORNER : BRANCH;
			const icon = s.outcome === "success" ? `${G}${CHECK}${X}` : s.outcome === "backtrack" ? `${R}${CROSS}${X}` : `${Y}${RING}${X}`;
			const attemptStr = `${s.attempts.length} attempt${s.attempts.length !== 1 ? "s" : ""}`;
			console.log(boxMid(`${prefix}${HORIZ} ${icon} ${B}${s.name}${X} ${D}(${attemptStr})${X}`));
			if (s.lesson) {
				const cont = isLast ? " " : VERT;
				console.log(boxMid(`${cont}    ${D}Lesson: ${s.lesson.substring(0, 55)}${X}`));
			}
		}
		console.log(boxMid(""));
		console.log(boxMid(`${D}Strategies: ${this.strategies.length}  Code runs: ${this.codeRunCount}  Validations: ${this.validationCount}${X}`));
		console.log(boxMid(`${D}Turns: ${totalCalls}  Tokens: ${totalTokens}  Time: ${(durationMs / 1000).toFixed(1)}s${X}`));
		console.log(boxBot());
	}
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
		name: `Scheduling (${diff}: ${problem.talks.length} talks, ${problem.rooms.length} rooms, ${problem.constraints.length} constraints)`,
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
		name: `Code from Tests: ${problem.title} (${problem.difficulty}, ${problem.testCount} tests)`,
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
		name: `Data Pipeline: ${problem.title} (${diff}, ${problem.inputData.length} records, ${problem.transformRules.length} rules)`,
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

	// Header
	console.log("");
	console.log(boxTop(demoProblem.name));
	console.log(boxMid(`${D}Model: ${model.name} (${model.id})${X}`));
	console.log(boxMid(`${D}Task:  ${demoProblem.task.substring(0, 65)}...${X}`));
	console.log(boxBot());

	const tree = new StrategyTree();

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

	console.log(`\n${D}Agent thinking...${X}`);

	const eventStream = agentLoop([userMessage], context, loopConfig);

	for await (const event of eventStream) {
		switch (event.type) {
			case "turn_start":
				totalCalls++;
				break;

			case "message_end":
				if (event.message.role === "assistant") {
					totalTokens += event.message.usage?.totalTokens ?? 0;
				}
				break;

			case "tool_execution_end": {
				const resultText = event.result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("");

				if (event.toolName === "record_strategy") {
					// Extract strategy name from the tool args
					const s = strategies[strategies.length - 1];
					if (s) {
						tree.startStrategy(s.strategy.name, s.strategy.approach);
					}
				} else if (event.toolName === "run_code") {
					tree.recordCodeRun();
					// Show a brief indicator
					const exitMatch = resultText.match(/exit_code: (\d+)/);
					const exitCode = exitMatch ? parseInt(exitMatch[1]) : -1;
					const indent = tree._indent();
					const icon = exitCode === 0 ? `${G}${CHECK}${X}` : `${R}${CROSS}${X}`;
					console.log(`${indent}${C}${VERT}${X} ${D}${icon} run_code ${ARROW} exit=${exitCode}${X}`);
				} else if (event.toolName === "validate_solution") {
					tree.validationCount++;
					const passed = resultText.includes("Passed: true");
					const scoreMatch = resultText.match(/Score: ([\d.]+)/);
					const score = scoreMatch ? parseFloat(scoreMatch[1]) : undefined;

					// Extract violations
					const violations = [];
					const violationLines = resultText.split("\n").filter((l) => l.trim().startsWith("- "));
					for (const vl of violationLines) {
						violations.push(vl.trim().replace(/^- /, ""));
					}

					tree.recordAttempt(passed, score, violations);

					if (passed) {
						solved = true;
						tree.markSuccess();
					}
				} else if (event.toolName === "record_lesson") {
					const s = strategies.find((st) => st.backtrack_reason);
					const lesson = s?.backtrack_reason?.lesson || resultText;
					tree.recordLesson(lesson);
				}
				break;
			}
		}
	}

	const durationMs = Math.round(performance.now() - startTime);

	// Final summary with strategy tree
	tree.renderSummary(totalCalls, totalTokens, durationMs);

	const statusIcon = solved ? `${G}${B}SOLVED ${CHECK}${X}` : `${R}${B}FAILED ${CROSS}${X}`;
	console.log(`\n  ${statusIcon}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , domain, variant] = process.argv;
const modelId = process.env.DEMO_MODEL || "mistralai/Devstral-Small-2-24B-Instruct-2512";

if (!domain || !["scheduling", "code-from-tests", "data-pipeline"].includes(domain)) {
	console.log(`\n${B}Task Agent Demo${X}\n`);
	console.log(`Usage: npx tsx demo.ts ${C}<domain>${X} ${D}[variant]${X}\n`);
	console.log(`Domains:`);
	console.log(`  ${C}scheduling${X}      ${D}[small|medium|hard]${X}       Constraint satisfaction`);
	console.log(`  ${C}code-from-tests${X} ${D}[merge-intervals|lru-cache|longest-palindrome]${X}`);
	console.log(`                                                 Iterative refinement`);
	console.log(`  ${C}data-pipeline${X}   ${D}[easy|medium|hard]${X}        Decomposition + composition`);
	console.log(`\nEnvironment:`);
	console.log(`  ${Y}NEURALWATT_API_KEY${X}  Required`);
	console.log(`  ${D}DEMO_MODEL${X}          Model ID (default: Devstral-24B)`);
	console.log("");
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
