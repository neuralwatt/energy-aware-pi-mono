/**
 * Model Comparison Demo
 *
 * Runs two Neuralwatt models head-to-head on the same coding challenge,
 * comparing energy, cost, tokens, time, and quality — no energy-aware
 * routing or discriminator logic.
 *
 * Usage:
 *   npx tsx src/demos/model-compare.ts                         (generate new challenge)
 *   npx tsx src/demos/model-compare.ts --static                (use hardcoded rate-limiter)
 *   npx tsx src/demos/model-compare.ts --runs 3                (3 comparison pairs)
 *   npx tsx src/demos/model-compare.ts --hard                  (hard challenges only)
 *   npx tsx src/demos/model-compare.ts --reverse               (run model-B first)
 *   npx tsx src/demos/model-compare.ts --budget 25000
 *   npx tsx src/demos/model-compare.ts --model-a moonshotai/Kimi-K2.5 --model-b neuralwatt/kimi-k2.5-long
 *
 * Requires NEURALWATT_API_KEY in the environment.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	type AssistantMessage,
	completeSimple,
	type Message,
	type Model,
	registerBuiltInApiProviders,
} from "@mariozechner/pi-ai";

// -- Models -------------------------------------------------------------------

let warnedMissingEnergy = false;

const NW_BASE = {
	api: "openai-completions" as const,
	provider: "neuralwatt" as const,
	baseUrl: "https://api.neuralwatt.com/v1",
	reasoning: false,
	input: ["text"] as ["text"],
};

/** Known models — looked up by ID for --model-a / --model-b overrides. */
const MODEL_CATALOG: Record<string, Model<"openai-completions">> = {
	"moonshotai/Kimi-K2.5": {
		id: "moonshotai/Kimi-K2.5",
		name: "Kimi K2.5",
		...NW_BASE,
		cost: { input: 0.52, output: 2.59, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 16_384,
	},
	"neuralwatt/kimi-k2.5-long": {
		id: "neuralwatt/kimi-k2.5-long",
		name: "Kimi K2.5 Long",
		...NW_BASE,
		cost: { input: 0.52, output: 2.59, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 16_384,
	},
	"kimi-k2.5-fast": {
		id: "kimi-k2.5-fast",
		name: "Kimi K2.5 Fast",
		...NW_BASE,
		cost: { input: 0.52, output: 2.59, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 16_384,
	},
	"Qwen/Qwen3.5-397B-A17B-FP8": {
		id: "Qwen/Qwen3.5-397B-A17B-FP8",
		name: "Qwen3.5 397B",
		...NW_BASE,
		cost: { input: 0.69, output: 4.14, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 16_384,
	},
	"mistralai/Devstral-Small-2-24B-Instruct-2512": {
		id: "mistralai/Devstral-Small-2-24B-Instruct-2512",
		name: "Devstral 24B",
		...NW_BASE,
		cost: { input: 0.12, output: 0.35, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 8_192,
	},
	"openai/gpt-oss-20b": {
		id: "openai/gpt-oss-20b",
		name: "GPT-OSS 20B",
		...NW_BASE,
		cost: { input: 0.03, output: 0.16, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 4_096,
	},
	"MiniMaxAI/MiniMax-M2.5": {
		id: "MiniMaxAI/MiniMax-M2.5",
		name: "MiniMax M2.5",
		...NW_BASE,
		cost: { input: 0.35, output: 1.38, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 196_608,
		maxTokens: 16_384,
	},
	"glm-5-fast": {
		id: "glm-5-fast",
		name: "GLM-5 Fast",
		...NW_BASE,
		cost: { input: 0.92, output: 2.94, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
	},
};

/** Resolve a model ID to a Model definition. Creates a generic one if not in catalog. */
function resolveModel(id: string): Model<"openai-completions"> {
	if (MODEL_CATALOG[id]) return MODEL_CATALOG[id];
	// Unknown model — create a default entry
	return {
		id,
		name: id.split("/").pop() ?? id,
		...NW_BASE,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 16_384,
	};
}

const DEFAULT_BUDGET_JOULES = 25_000;

// -- Task definition ----------------------------------------------------------

const SYSTEM_PROMPT =
	"You are an expert TypeScript engineer. " +
	"Implement code concisely and correctly. " +
	"Include TypeScript types and JSDoc for public APIs. " +
	"Each response should be tightly focused — implement only what is asked. " +
	"No preamble, no prose explanations, just the code.";

const DEFAULT_BUILD_TURNS = [
	"Design a TypeScript interface for a rate limiter: RateLimiterOptions (windowMs, maxRequests, keyFn) and RateLimiterState (map of key to {count, resetAt}). Keep it concise.",
	"Implement a RateLimiter class using those interfaces. Include: constructor(options), isAllowed(key): boolean method that enforces the sliding window. Add JSDoc.",
	"Write an Express-style middleware factory: createRateLimitMiddleware(options: RateLimiterOptions): (req, res, next) => void. It should set X-RateLimit-Remaining and X-RateLimit-Reset headers, and return 429 with a JSON error when the limit is exceeded.",
	"Add input validation to the RateLimiter constructor: throw descriptive errors for invalid windowMs (must be > 0), invalid maxRequests (must be > 0 integer), and missing keyFn.",
];

const DEFAULT_CONSOLIDATE_PROMPT =
	"Write the final complete TypeScript implementation combining everything built so far.\n\n" +
	"Required exports:\n" +
	"  export interface RateLimiterOptions { windowMs: number; maxRequests: number; keyFn: (req: unknown) => string }\n" +
	"  export interface RateLimiterState { count: number; resetAt: number }\n" +
	"  export class RateLimiter { constructor(options: RateLimiterOptions); isAllowed(key: string): boolean }\n" +
	"  export function createRateLimitMiddleware(options: RateLimiterOptions): (req: unknown, res: unknown, next: () => void) => void\n\n" +
	"Middleware requirements (synchronous, not async):\n" +
	"  1. Create a RateLimiter internally with the provided options\n" +
	"  2. In each request: derive key via options.keyFn(req)\n" +
	"  3. If limiter.isAllowed(key): call (res as any).set('X-RateLimit-Remaining', String(remaining)) then call next()\n" +
	"  4. If not allowed: call (res as any).status(429).json({ error: 'Too Many Requests' })\n\n" +
	"Validation in RateLimiter constructor: throw if windowMs <= 0, maxRequests <= 0, or keyFn missing.\n" +
	"No imports except standard TypeScript — do not import Express or any npm package.\n" +
	"Output raw TypeScript only — no markdown fences, no explanations.";

const DEFAULT_FIX_EXTRA =
	"Critical requirements for this task:\n" +
	"  - createRateLimitMiddleware must be SYNCHRONOUS (not async)\n" +
	"  - Middleware must call options.keyFn(req) to get the key, then call limiter.isAllowed(key)\n" +
	"  - If allowed: call (res as any).set('X-RateLimit-Remaining', String(remaining)) then call next()\n" +
	"  - If not allowed: call (res as any).status(429).json({ error: 'Too Many Requests' })\n";

const DEFAULT_ACCEPTANCE_TEST = `
import assert from 'node:assert/strict';
import { RateLimiter, createRateLimitMiddleware } from './impl.js';

let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
   try {
      await fn();
      console.log('PASS: ' + name);
   } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log('FAIL: ' + name + ': ' + msg);
      failed++;
   }
}

/** Mock res that accepts set/setHeader/header interchangeably. */
function mockRes(): { headers: Record<string, string>; res: Record<string, unknown> } {
   const headers: Record<string, string> = {};
   const res: Record<string, unknown> = {};
   const setH = (k: string, v: unknown) => { headers[String(k).toLowerCase()] = String(v); return res; };
   res['set'] = setH;
   res['setHeader'] = setH;
   res['header'] = setH;
   res['status'] = () => res;
   res['json'] = () => {};
   res['send'] = () => res;
   return { headers, res };
}

await test('allows requests within limit', () => {
   const rl = new RateLimiter({ windowMs: 1000, maxRequests: 3, keyFn: () => 'test' });
   assert.equal(rl.isAllowed('test'), true, 'first request should be allowed');
   assert.equal(rl.isAllowed('test'), true, 'second request should be allowed');
   assert.equal(rl.isAllowed('test'), true, 'third request should be allowed');
});

await test('blocks requests over limit', () => {
   const rl = new RateLimiter({ windowMs: 60000, maxRequests: 2, keyFn: () => 'test' });
   rl.isAllowed('test');
   rl.isAllowed('test');
   assert.equal(rl.isAllowed('test'), false, 'third request should be blocked');
});

await test('throws on invalid windowMs', () => {
   assert.throws(() => new RateLimiter({ windowMs: -1, maxRequests: 5, keyFn: () => 'k' }), 'should throw for windowMs <= 0');
});

await test('throws on invalid maxRequests', () => {
   assert.throws(() => new RateLimiter({ windowMs: 1000, maxRequests: 0, keyFn: () => 'k' }), 'should throw for maxRequests <= 0');
});

await test('middleware sets headers and calls next()', async () => {
   const mw = createRateLimitMiddleware({ windowMs: 60000, maxRequests: 10, keyFn: (req: unknown) => {
      const r = req as { ip?: string };
      return r.ip ?? 'anon';
   }});
   let nextCalled = false;
   const { headers, res } = mockRes();
   const req = { ip: '127.0.0.1' };
   await (mw as (req: unknown, res: unknown, next: () => void) => void | Promise<void>)(
      req, res, () => { nextCalled = true; }
   );
   assert.equal(nextCalled, true, 'middleware must call next() when request is within limit');
   const hasRemainingHeader = 'x-ratelimit-remaining' in headers || 'x-ratelimit-reset' in headers;
   assert.ok(hasRemainingHeader, 'middleware must set X-RateLimit-Remaining or X-RateLimit-Reset header');
});

if (failed > 0) process.exit(1);
`.trimStart();

// -- Challenge generation -----------------------------------------------------

interface ChallengeTopic {
	topic: string;
	difficulty: "standard" | "hard";
}

const CHALLENGE_TOPICS: ChallengeTopic[] = [
	{ topic: "LRU cache", difficulty: "standard" },
	{ topic: "debounce/throttle utility", difficulty: "standard" },
	{ topic: "event emitter", difficulty: "standard" },
	{ topic: "retry with exponential backoff", difficulty: "standard" },
	{ topic: "promise queue with concurrency limit", difficulty: "standard" },
	{ topic: "memoize with TTL", difficulty: "standard" },
	{ topic: "circular buffer (ring buffer)", difficulty: "standard" },
	{ topic: "priority queue (min-heap)", difficulty: "standard" },
	{ topic: "pub-sub message bus", difficulty: "standard" },
	{ topic: "undo-redo stack", difficulty: "standard" },
	{ topic: "object pool with auto-reclaim", difficulty: "standard" },
	{ topic: "middleware pipeline", difficulty: "standard" },
	{ topic: "observable with switchMap, mergeMap, and backpressure", difficulty: "hard" },
	{ topic: "trie with wildcard search and prefix-count", difficulty: "hard" },
	{ topic: "skip list with probabilistic balancing", difficulty: "hard" },
	{ topic: "async dependency resolver (topological sort with cycle detection)", difficulty: "hard" },
	{ topic: "interval tree with overlap queries", difficulty: "hard" },
	{ topic: "CRDT counter (conflict-free replicated data type)", difficulty: "hard" },
	{ topic: "regex engine supporting ., *, +, and ? operators", difficulty: "hard" },
	{ topic: "constraint propagation solver (Sudoku-style)", difficulty: "hard" },
	{ topic: "persistent (immutable) balanced BST with structural sharing", difficulty: "hard" },
	{ topic: "async stream with map, filter, take, and backpressure", difficulty: "hard" },
	{ topic: "expression parser and evaluator with operator precedence", difficulty: "hard" },
	{ topic: "cron expression parser and next-run calculator", difficulty: "hard" },
];

function buildChallengePrompt(hardOnly = false): { prompt: string; topic: string; difficulty: string } {
	const pool = hardOnly ? CHALLENGE_TOPICS.filter((e) => e.difficulty === "hard") : CHALLENGE_TOPICS;
	const entry = pool[Math.floor(Math.random() * pool.length)];
	const difficultyGuide =
		entry.difficulty === "hard"
			? "This is a HARD challenge. The build turns should require non-trivial algorithmic reasoning:\n" +
				"  1. Define the core types/interfaces — include any non-obvious data structures needed\n" +
				"  2. Implement the core algorithm (the tricky part — correctness matters)\n" +
				"  3. Add advanced operations, edge cases, and performance-sensitive paths\n"
			: "buildTurns must have exactly 3 prompts that build incrementally:\n" +
				"  1. Define the TypeScript interfaces/types for the data structure\n" +
				"  2. Implement the core class or function\n" +
				"  3. Add input validation and edge-case handling\n";

	const prompt =
		`Generate a TypeScript coding challenge about: ${entry.topic}\n` +
		"Reply with ONLY a JSON object — no prose, no markdown fences.\n\n" +
		'{"taskLabel":"<50-char description>","buildTurns":["turn1","turn2","turn3"],"consolidatePrompt":"...","acceptanceTest":"...TypeScript source..."}\n\n' +
		`${difficultyGuide}\n` +
		"consolidatePrompt must:\n" +
		"  - Ask for a single impl.ts combining everything\n" +
		"  - List EXACT exports with their TypeScript signatures, e.g.: export class Foo {...} export function bar(...) {...}\n" +
		"  - End with: No imports except node standard lib. Output raw TypeScript only — no markdown fences.\n\n" +
		"acceptanceTest must be valid TypeScript that:\n" +
		"  - Starts with: import assert from 'node:assert/strict';\n" +
		"  - Imports the named exports from './impl.js'\n" +
		"  - Uses this EXACT test harness (copy verbatim):\n" +
		"      let failed = 0;\n" +
		"      async function test(name: string, fn: () => void | Promise<void>): Promise<void> {\n" +
		"        try { await fn(); console.log('PASS: ' + name); }\n" +
		"        catch (e) { const msg = e instanceof Error ? e.message : String(e); console.log('FAIL: ' + name + ': ' + msg); failed++; }\n" +
		"      }\n" +
		"  - Has 4-5 test cases covering: happy path, boundary conditions, error cases\n" +
		"  - Ends with: if (failed > 0) process.exit(1);\n" +
		"  - Uses only top-level await and node:assert (no timeouts, no randomness)\n\n" +
		"AVOID: rate limiting, express middleware, HTTP servers, auth systems.\n\n" +
		"Output ONLY the JSON object.";
	return { prompt, topic: entry.topic, difficulty: entry.difficulty };
}

interface GeneratedChallenge {
	taskLabel: string;
	buildTurns: string[];
	consolidatePrompt: string;
	acceptanceTest: string;
	difficulty: "standard" | "hard";
}

async function generateChallenge(
	generatorModel: Model<"openai-completions">,
	apiKey: string,
	hardOnly = false,
): Promise<GeneratedChallenge | null> {
	const challenge = buildChallengePrompt(hardOnly);
	const diffTag = challenge.difficulty === "hard" ? " \x1b[31m[HARD]\x1b[0m" : "";
	process.stdout.write(`  Generating challenge via ${generatorModel.name}...${diffTag} topic: ${challenge.topic}`);
	try {
		const msg = await completeSimple(
			generatorModel,
			{
				systemPrompt: "You are a technical challenge designer. Output only valid JSON.",
				messages: [{ role: "user", content: challenge.prompt, timestamp: Date.now() }],
			},
			{ apiKey, maxTokens: 3_000 },
		);
		const text = msg.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { type: "text"; text: string }).text)
			.join("");

		let parsed: unknown = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			const m = text.match(/\{[\s\S]*\}/);
			if (m) {
				try {
					parsed = JSON.parse(m[0]);
				} catch {
					// fall through
				}
			}
		}

		if (!parsed || typeof parsed !== "object") {
			console.log(" ✗ (invalid JSON, using default task)");
			return null;
		}

		const c = parsed as Record<string, unknown>;
		if (
			typeof c.taskLabel !== "string" ||
			!Array.isArray(c.buildTurns) ||
			c.buildTurns.length < 2 ||
			!c.buildTurns.every((t) => typeof t === "string") ||
			typeof c.consolidatePrompt !== "string" ||
			typeof c.acceptanceTest !== "string"
		) {
			console.log(" ✗ (schema mismatch, using default task)");
			return null;
		}

		const label = c.taskLabel.slice(0, 55);
		console.log(` ✓ "${label}"`);
		return {
			taskLabel: label,
			buildTurns: c.buildTurns as string[],
			consolidatePrompt: c.consolidatePrompt as string,
			acceptanceTest: c.acceptanceTest as string,
			difficulty: challenge.difficulty as "standard" | "hard",
		};
	} catch (e) {
		console.log(` ✗ (${(e as Error).message?.slice(0, 50) ?? "error"}, using default task)`);
		return null;
	}
}

// -- Run config ---------------------------------------------------------------

interface RunConfig {
	taskLabel: string;
	buildTurns: string[];
	consolidatePrompt: string;
	acceptanceTest: string | null;
	fixPromptExtra: string;
	generated: boolean;
	difficulty?: "standard" | "hard";
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_TSX = join(__dirname, "../../../../node_modules/.bin/tsx");

// -- Helpers ------------------------------------------------------------------

function getEnergy(message: AssistantMessage, modelId: string): { joules: number; fromApi: boolean } {
	const api = message.energy?.energy_joules;
	if (api != null && api > 0) return { joules: api, fromApi: true };
	if (!warnedMissingEnergy) {
		warnedMissingEnergy = true;
		console.error(
			`\x1b[33m  ⚠ WARNING: No energy telemetry in API response for model "${modelId}".` +
				`\n    Energy values will be reported as 0J. Use a Neuralwatt endpoint for accurate energy data.\x1b[0m`,
		);
	}
	return { joules: 0, fromApi: false };
}

function extractCode(text: string): string {
	const m = text.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
	return m ? m[1] : text;
}

interface TestResult {
	passed: boolean;
	output: string;
	passedTests: string[];
	failedTests: string[];
}

function runAcceptanceTest(code: string, testSource: string): TestResult {
	const tmpDir = mkdtempSync(join(tmpdir(), "model-compare-"));
	try {
		writeFileSync(join(tmpDir, "impl.ts"), code, "utf8");
		writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
		writeFileSync(join(tmpDir, "acceptance.ts"), testSource, "utf8");

		let output = "";
		try {
			output = execSync(`"${REPO_TSX}" acceptance.ts`, {
				cwd: tmpDir,
				encoding: "utf8",
				timeout: 30_000,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			const err = e as { stdout?: string; stderr?: string; message?: string };
			output = [err.stdout ?? "", err.stderr ?? ""].filter(Boolean).join("\n");
			if (!output) output = (e as Error).message ?? "Unknown error";
		}

		const passedTests: string[] = [];
		const failedTests: string[] = [];
		for (const line of output.split("\n")) {
			if (line.startsWith("PASS: ")) passedTests.push(line.slice(6).trim());
			else if (line.startsWith("FAIL: ")) failedTests.push(line.slice(6).trim());
		}
		return { passed: failedTests.length === 0 && passedTests.length > 0, output, passedTests, failedTests };
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

function energyBar(consumed: number, budget: number, width = 20): string {
	if (budget <= 0) return `${consumed.toFixed(2)}J`;
	const pct = consumed / budget;
	const filled = Math.min(width, Math.round(Math.min(1, pct) * width));
	const bar = "█".repeat(filled) + "░".repeat(width - filled);
	const color = pct >= 0.9 ? "\x1b[31m" : pct >= 0.7 ? "\x1b[33m" : "\x1b[32m";
	const pctLabel = pct > 1 ? `\x1b[31m${Math.round(pct * 100)}%\x1b[0m` : `${Math.round(pct * 100)}%`;
	return `${color}[${bar}]\x1b[0m ${consumed.toFixed(0)}J / ${budget}J (${pctLabel})`;
}

function truncateCode(text: string, maxLines = 8): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return `${lines.slice(0, maxLines).join("\n")}\n  \x1b[2m… (${lines.length - maxLines} more lines)\x1b[0m`;
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { type: "text"; text: string }).text)
		.join("");
}

// -- Run one model ------------------------------------------------------------

interface TurnResult {
	turn: number;
	phase: string;
	model: string;
	energy: number;
	tokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
}

interface RunStats {
	modelLabel: string;
	modelId: string;
	totalEnergy: number;
	totalTokens: number;
	totalInputTokens: number;
	totalCacheRead: number;
	turns: TurnResult[];
	startTime: number;
	endTime: number;
	testPassed?: boolean;
	turnsToPass?: number;
	failedTestNames: string[];
}

async function runModel(
	label: string,
	model: Model<"openai-completions">,
	config: RunConfig,
	apiKey: string,
	budgetJ: number,
): Promise<RunStats> {
	const stats: RunStats = {
		modelLabel: label,
		modelId: model.id,
		totalEnergy: 0,
		totalTokens: 0,
		totalInputTokens: 0,
		totalCacheRead: 0,
		turns: [],
		startTime: Date.now(),
		endTime: 0,
		failedTestNames: [],
	};

	const messages: Message[] = [];
	const tag = label === "Model A" ? "\x1b[36m[Model A  ]\x1b[0m" : "\x1b[35m[Model B  ]\x1b[0m";

	console.log(`\n${"═".repeat(70)}`);
	console.log(`  Running: ${label}  |  ${model.name} (${model.id})`);
	console.log(`  Budget: ${budgetJ}J (display only)`);
	console.log(`${"═".repeat(70)}`);

	async function runTurn(prompt: string, phaseLabel: string): Promise<void> {
		const turnNum = stats.turns.length + 1;
		const phase = simplifyPhase(phaseLabel);

		console.log(
			`\n${tag} Turn ${turnNum}  ${phaseLabel}  model: ${model.id}  ${energyBar(stats.totalEnergy, budgetJ)}`,
		);
		console.log(`  \x1b[2m${prompt.slice(0, 90)}${prompt.length > 90 ? "…" : ""}\x1b[0m`);

		messages.push({ role: "user", content: prompt, timestamp: Date.now() });

		let assistantMsg: AssistantMessage | undefined;
		let lastError: string | undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			const msg = await completeSimple(model, { systemPrompt: SYSTEM_PROMPT, messages }, { apiKey });
			const errorMsg = (msg as unknown as Record<string, unknown>).errorMessage;
			if (msg.stopReason === "error" || errorMsg) {
				lastError = `${errorMsg ?? "unknown"}`;
				if (attempt < 2) {
					console.log(`  \x1b[33m⚠ API error (${model.id}): ${lastError} — retrying (${attempt + 1}/3)…\x1b[0m`);
					await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
				}
			} else {
				assistantMsg = msg;
				break;
			}
		}
		if (!assistantMsg) {
			throw new Error(`API error (${model.id}): ${lastError} (after 3 attempts)`);
		}

		messages.push(assistantMsg);

		const { joules: energy, fromApi } = getEnergy(assistantMsg, model.id);
		const tokens = assistantMsg.usage.totalTokens;
		const inputTokens = assistantMsg.usage.input;
		const cacheRead = assistantMsg.usage.cacheRead;
		stats.totalEnergy += energy;
		stats.totalTokens += tokens;
		stats.totalInputTokens += inputTokens;
		stats.totalCacheRead += cacheRead;

		const energyLabel = fromApi ? "api" : "est";
		const totalPrompt = inputTokens + cacheRead;
		const cachePct = totalPrompt > 0 && cacheRead > 0 ? Math.round((cacheRead / totalPrompt) * 100) : 0;
		const cacheLabel = cacheRead > 0 ? ` \x1b[33m(${cacheRead} cached = ${cachePct}% of input)\x1b[0m` : "";
		console.log(
			`  \x1b[2m${tokens} tokens | ${energy.toFixed(1)}J [${energyLabel}] | input:${inputTokens} output:${assistantMsg.usage.output}\x1b[0m${cacheLabel}`,
		);

		const responseText = extractText(assistantMsg);
		console.log(truncateCode(responseText, 10));

		stats.turns.push({
			turn: turnNum,
			phase,
			model: model.id,
			energy,
			tokens,
			inputTokens,
			outputTokens: assistantMsg.usage.output,
			cacheRead,
		});
	}

	// Phase 1: Build
	for (let i = 0; i < config.buildTurns.length; i++) {
		await runTurn(config.buildTurns[i], `[build ${i + 1}/${config.buildTurns.length}]`);
	}

	// Phase 2: Consolidate
	await runTurn(config.consolidatePrompt, "[consolidate]");

	// Phase 3: Acceptance tests
	if (!config.acceptanceTest) {
		stats.endTime = Date.now();
		const elapsed = ((stats.endTime - stats.startTime) / 1000).toFixed(1);
		console.log(
			`\n  \x1b[1mDone: ${stats.turns.length} turns | ${stats.totalEnergy.toFixed(0)}J | ${stats.totalTokens} tokens | ${elapsed}s\x1b[0m`,
		);
		return stats;
	}

	const lastMsg = messages[messages.length - 1] as AssistantMessage;
	let code = extractCode(extractText(lastMsg));
	let testResult = runAcceptanceTest(code, config.acceptanceTest);
	printTestResults(testResult);

	if (testResult.passed) {
		stats.testPassed = true;
		stats.turnsToPass = stats.turns.length;
		console.log(`\n  \x1b[32m✓ All acceptance tests passed on turn ${stats.turns.length}\x1b[0m`);
	} else {
		for (const f of testResult.failedTests) {
			const name = f.includes(": ") ? f.slice(0, f.indexOf(": ")) : f;
			if (!stats.failedTestNames.includes(name)) stats.failedTestNames.push(name);
		}

		const MAX_FIX_ATTEMPTS = 5;
		let fixAttempt = 0;
		while (!testResult.passed && fixAttempt < MAX_FIX_ATTEMPTS) {
			fixAttempt++;
			const failureSummary =
				testResult.failedTests.length > 0
					? testResult.failedTests.map((f) => `  - ${f}`).join("\n")
					: testResult.output.split("\n").slice(0, 10).join("\n");

			const importLine = config.acceptanceTest?.match(/import \{[^}]+\} from ['"]\.\/impl\.js['"]/)?.[0];
			const importHint = importLine ? `\nThe test imports: ${importLine}\nYou MUST export these exact names.\n` : "";

			const fixPrompt =
				`The acceptance tests failed:\n${failureSummary}\n${importHint}\n` +
				(config.fixPromptExtra ? `${config.fixPromptExtra}\n` : "") +
				"Write the complete corrected implementation as a single TypeScript file. " +
				"Make sure all classes and functions are named exports (use 'export class', 'export function'). " +
				"No external imports. Output raw TypeScript only — no markdown fences.";

			await runTurn(fixPrompt, `[fix #${fixAttempt}]`);

			const fixMsg = messages[messages.length - 1] as AssistantMessage;
			code = extractCode(extractText(fixMsg));
			testResult = runAcceptanceTest(code, config.acceptanceTest);
			printTestResults(testResult);

			if (testResult.passed) {
				stats.testPassed = true;
				stats.turnsToPass = stats.turns.length;
				console.log(
					`\n  \x1b[32m✓ All acceptance tests passed on turn ${stats.turns.length} (+${fixAttempt} fix${fixAttempt !== 1 ? "es" : ""})\x1b[0m`,
				);
			} else {
				for (const f of testResult.failedTests) {
					const name = f.includes(": ") ? f.slice(0, f.indexOf(": ")) : f;
					if (!stats.failedTestNames.includes(name)) stats.failedTestNames.push(name);
				}
				if (fixAttempt >= MAX_FIX_ATTEMPTS) {
					console.log(`\n  \x1b[31m✗ Giving up after ${MAX_FIX_ATTEMPTS} fix attempts\x1b[0m`);
				} else {
					console.log(
						`  → ${testResult.failedTests.length} test${testResult.failedTests.length !== 1 ? "s" : ""} failed — requesting correction`,
					);
				}
			}
		}
	}

	stats.endTime = Date.now();
	const elapsed = ((stats.endTime - stats.startTime) / 1000).toFixed(1);
	console.log(
		`\n  \x1b[1mDone: ${stats.turns.length} turns | ${stats.totalEnergy.toFixed(0)}J | ${stats.totalTokens} tokens | ${elapsed}s\x1b[0m`,
	);
	return stats;
}

function simplifyPhase(phaseLabel: string): string {
	const buildMatch = phaseLabel.match(/\[build (\d+)/);
	if (buildMatch) return `build-${buildMatch[1]}`;
	if (phaseLabel.includes("[consolidate]")) return "consolidate";
	const fixMatch = phaseLabel.match(/\[fix #(\d+)\]/);
	if (fixMatch) return `fix-${fixMatch[1]}`;
	return phaseLabel.trim();
}

function printTestResults(result: TestResult): void {
	console.log("  \x1b[1m[acceptance test]\x1b[0m");
	for (const t of result.passedTests) {
		console.log(`    \x1b[32m✓ ${t}\x1b[0m`);
	}
	for (const t of result.failedTests) {
		console.log(`    \x1b[31m✗ ${t}\x1b[0m`);
	}
	if (result.passedTests.length === 0 && result.failedTests.length === 0) {
		const snippet = result.output.split("\n").slice(0, 6).join("\n");
		console.log(`    \x1b[31m${snippet}\x1b[0m`);
	}
}

// -- Cost helpers -------------------------------------------------------------

function modelCostRates(modelId: string): { input: number; output: number } {
	const model = MODEL_CATALOG[modelId];
	if (!model) return { input: 0, output: 0 };
	return { input: model.cost.input, output: model.cost.output };
}

function estimateCost(turns: { inputTokens: number; outputTokens: number; model: string }[]): number {
	return turns.reduce((sum, t) => {
		const rates = modelCostRates(t.model);
		return sum + (t.inputTokens * rates.input + t.outputTokens * rates.output) / 1_000_000;
	}, 0);
}

// -- Scorecard ----------------------------------------------------------------

function printScorecard(statsA: RunStats, statsB: RunStats, config: RunConfig, budget: number, runLabel = ""): void {
	const timeA = (statsA.endTime - statsA.startTime) / 1000;
	const timeB = (statsB.endTime - statsB.startTime) / 1000;
	const energyDiff =
		statsA.totalEnergy > 0 ? ((statsA.totalEnergy - statsB.totalEnergy) / statsA.totalEnergy) * 100 : 0;
	const timeDiff = timeA > 0 ? ((timeB - timeA) / timeA) * 100 : 0;

	const costA = estimateCost(statsA.turns);
	const costB = estimateCost(statsB.turns);
	const costDiff = costA > 0 ? ((costA - costB) / costA) * 100 : 0;

	const fmtDelta = (val: number, positive = "+"): string => `${val >= 0 ? positive : ""}${val.toFixed(0)}%`;

	const consolidateTurnOffset = config.buildTurns.length + 1;
	const fmtQuality = (s: RunStats): string => {
		if (!config.acceptanceTest) return "n/a (no tests)";
		if (s.testPassed === true) {
			const fixCount = s.turnsToPass != null ? Math.max(0, s.turnsToPass - consolidateTurnOffset) : 0;
			const fixes = fixCount > 0 ? `, +${fixCount} fix${fixCount !== 1 ? "es" : ""}` : ", +0 fixes";
			return `✓ PASSED (turn ${s.turnsToPass}${fixes})`;
		}
		return "✗ FAILED";
	};

	const header = runLabel ? `SCORECARD ${runLabel} — Model Comparison` : "FINAL SCORECARD — Model Comparison";

	const rowSep = "  +-----------------+---------------------------+---------------------------+";

	console.log(`\n${"═".repeat(76)}`);
	console.log(`  ${header}`);
	console.log(`${"═".repeat(76)}`);
	console.log(`  Task:   ${config.taskLabel}`);
	console.log(
		`  Budget: ${budget}J (display)  |  ${config.generated ? `LLM-generated challenge${config.difficulty === "hard" ? " \x1b[31m[HARD]\x1b[0m" : ""}` : "hardcoded rate-limiter"}`,
	);
	console.log(rowSep);
	console.log(`  |                 | Model A (baseline)        | Model B (challenger)      |`);
	console.log(rowSep);

	const row = (label: string, valA: string, valB: string): void => {
		console.log(`  | ${label.padEnd(15)} | ${valA.padEnd(25)} | ${valB.padEnd(25)} |`);
	};

	row("Model", statsA.modelId, statsB.modelId);
	row("Turns", String(statsA.turns.length), String(statsB.turns.length));
	row(
		"Energy used",
		`${statsA.totalEnergy.toFixed(0)} J`,
		`${statsB.totalEnergy.toFixed(0)} J  (${fmtDelta(-energyDiff, "-")})`,
	);

	const totalCacheRead = statsA.totalCacheRead + statsB.totalCacheRead;
	if (totalCacheRead > 0) {
		const fmtCache = (cr: number, inp: number) => {
			if (cr === 0) return "none";
			const totalPrompt = inp + cr;
			const pct = totalPrompt > 0 ? Math.round((cr / totalPrompt) * 100) : 0;
			return `\x1b[33m${cr} tok (${pct}%)\x1b[0m`;
		};
		row(
			"Cache reads",
			fmtCache(statsA.totalCacheRead, statsA.totalInputTokens),
			fmtCache(statsB.totalCacheRead, statsB.totalInputTokens),
		);
	}

	row("Est. cost", `$${costA.toFixed(4)}`, `$${costB.toFixed(4)}  (${fmtDelta(-costDiff, "-")})`);
	row("Tokens used", String(statsA.totalTokens), String(statsB.totalTokens));
	row("Wall time", `${timeA.toFixed(1)} s`, `${timeB.toFixed(1)} s  (${fmtDelta(timeDiff)})`);
	if (config.acceptanceTest) {
		row("Quality", fmtQuality(statsA), fmtQuality(statsB));
	}
	console.log(rowSep);

	// Per-turn energy comparison
	const maxTurns = Math.max(statsA.turns.length, statsB.turns.length);
	if (maxTurns > 0) {
		console.log("\n  PER-TURN ENERGY COMPARISON:");
		console.log(`    ${"Phase".padEnd(14)} ${"Model A".padEnd(22)} ${"Model B".padEnd(22)} Diff`);
		console.log(`    ${"─".repeat(14)} ${"─".repeat(22)} ${"─".repeat(22)} ${"─".repeat(10)}`);
		for (let i = 0; i < maxTurns; i++) {
			const tA = statsA.turns[i];
			const tB = statsB.turns[i];
			const phase = (tA?.phase ?? tB?.phase ?? `turn-${i + 1}`).padEnd(14);
			const eA = tA ? `${tA.energy.toFixed(1)}J (${tA.tokens} tok)` : "—";
			const eB = tB ? `${tB.energy.toFixed(1)}J (${tB.tokens} tok)` : "—";
			const diff = tA && tB && tA.energy > 0 ? `${(((tA.energy - tB.energy) / tA.energy) * 100).toFixed(0)}%` : "—";
			console.log(`    ${phase} ${eA.padEnd(22)} ${eB.padEnd(22)} ${diff}`);
		}
	}

	console.log("");
	if (energyDiff > 0) {
		console.log(
			`  \x1b[32m✓ Model B uses ${energyDiff.toFixed(0)}% less energy, ${costDiff.toFixed(0)}% lower cost\x1b[0m`,
		);
	} else if (energyDiff < 0) {
		console.log(
			`  \x1b[33m→ Model B uses ${Math.abs(energyDiff).toFixed(0)}% MORE energy, ${Math.abs(costDiff).toFixed(0)}% higher cost\x1b[0m`,
		);
	} else {
		console.log(`  → Models used equal energy`);
	}
}

// -- Multi-run ----------------------------------------------------------------

interface RunPair {
	runIndex: number;
	order: "a-first" | "b-first";
	config: RunConfig;
	statsA: RunStats;
	statsB: RunStats;
}

async function buildRunConfig(
	isStatic: boolean,
	taskStr: string | undefined,
	acceptancePath: string | undefined,
	generatorModel: Model<"openai-completions">,
	apiKey: string,
	hardOnly = false,
): Promise<RunConfig> {
	if (taskStr) {
		const acceptanceTest = acceptancePath ? readFileSync(acceptancePath, "utf8") : null;
		return {
			taskLabel: taskStr.slice(0, 60),
			buildTurns: [taskStr],
			consolidatePrompt:
				"Write the final complete implementation as a single TypeScript file named impl.ts, " +
				"incorporating everything built so far. " +
				"Export all public types and functions. " +
				"No external imports. Output raw TypeScript only — no markdown fences.",
			acceptanceTest,
			fixPromptExtra: "",
			generated: false,
		};
	}

	if (isStatic) {
		return {
			taskLabel: "TypeScript rate-limiting middleware with acceptance tests",
			buildTurns: DEFAULT_BUILD_TURNS,
			consolidatePrompt: DEFAULT_CONSOLIDATE_PROMPT,
			acceptanceTest: DEFAULT_ACCEPTANCE_TEST,
			fixPromptExtra: DEFAULT_FIX_EXTRA,
			generated: false,
		};
	}

	const gen = await generateChallenge(generatorModel, apiKey, hardOnly);
	if (gen) {
		return {
			taskLabel: gen.taskLabel,
			buildTurns: gen.buildTurns,
			consolidatePrompt: gen.consolidatePrompt,
			acceptanceTest: gen.acceptanceTest,
			fixPromptExtra:
				"Re-implement the complete solution satisfying all exports specified in the consolidation prompt.",
			generated: true,
			difficulty: gen.difficulty,
		};
	}
	return {
		taskLabel: "TypeScript rate-limiting middleware with acceptance tests",
		buildTurns: DEFAULT_BUILD_TURNS,
		consolidatePrompt: DEFAULT_CONSOLIDATE_PROMPT,
		acceptanceTest: DEFAULT_ACCEPTANCE_TEST,
		fixPromptExtra: DEFAULT_FIX_EXTRA,
		generated: false,
	};
}

function printAggregateScorecard(
	pairs: RunPair[],
	modelA: Model<"openai-completions">,
	modelB: Model<"openai-completions">,
): void {
	const aFirstCount = pairs.filter((p) => p.order === "a-first").length;
	const bFirstCount = pairs.filter((p) => p.order === "b-first").length;

	const aPassed = pairs.filter((p) => p.statsA.testPassed).length;
	const bPassed = pairs.filter((p) => p.statsB.testPassed).length;

	const allPassed = pairs.filter((p) => p.statsA.testPassed && p.statsB.testPassed);
	const nPassed = allPassed.length;

	const avgAEnergy = nPassed > 0 ? allPassed.reduce((s, p) => s + p.statsA.totalEnergy, 0) / nPassed : 0;
	const avgBEnergy = nPassed > 0 ? allPassed.reduce((s, p) => s + p.statsB.totalEnergy, 0) / nPassed : 0;
	const avgSavedPct =
		nPassed > 0
			? allPassed.reduce((s, p) => {
					const saved =
						p.statsA.totalEnergy > 0
							? ((p.statsA.totalEnergy - p.statsB.totalEnergy) / p.statsA.totalEnergy) * 100
							: 0;
					return s + saved;
				}, 0) / nPassed
			: 0;

	const avgACost = nPassed > 0 ? allPassed.reduce((s, p) => s + estimateCost(p.statsA.turns), 0) / nPassed : 0;
	const avgBCost = nPassed > 0 ? allPassed.reduce((s, p) => s + estimateCost(p.statsB.turns), 0) / nPassed : 0;
	const avgCostSavedPct = avgACost > 0 ? ((avgACost - avgBCost) / avgACost) * 100 : 0;

	const avgATime =
		nPassed > 0 ? allPassed.reduce((s, p) => s + (p.statsA.endTime - p.statsA.startTime) / 1000, 0) / nPassed : 0;
	const avgBTime =
		nPassed > 0 ? allPassed.reduce((s, p) => s + (p.statsB.endTime - p.statsB.startTime) / 1000, 0) / nPassed : 0;
	const avgTimeDiffPct = avgATime > 0 ? ((avgATime - avgBTime) / avgATime) * 100 : 0;

	const taskCol = 32;
	const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
	const tableWidth = 90;

	console.log(`\n${"═".repeat(tableWidth)}`);
	console.log(
		`  AGGREGATE — ${pairs.length} run${pairs.length !== 1 ? "s" : ""}  (${aFirstCount} A-first, ${bFirstCount} B-first)`,
	);
	console.log(`  Model A: ${modelA.name} (${modelA.id})`);
	console.log(`  Model B: ${modelB.name} (${modelB.id})`);
	console.log(`${"═".repeat(tableWidth)}`);

	console.log(
		`  ${"#  Task".padEnd(taskCol)}  ${"Order".padEnd(10)}  ${"Model A".padEnd(10)}  ${"Model B".padEnd(10)}  ${"Diff".padEnd(8)}  Quality`,
	);
	console.log(
		`  ${"─".repeat(taskCol)}  ${"─".repeat(10)}  ${"─".repeat(10)}  ${"─".repeat(10)}  ${"─".repeat(8)}  ───────`,
	);

	for (const p of pairs) {
		const orderLabel = p.order === "a-first" ? "A→B" : "B→A";
		const savedPct =
			p.statsA.totalEnergy > 0 ? ((p.statsA.totalEnergy - p.statsB.totalEnergy) / p.statsA.totalEnergy) * 100 : 0;
		const qualLabel = `${p.statsA.testPassed ? "✓" : "✗"}/${p.statsB.testPassed ? "✓" : "✗"}`;
		const taskStr = `${p.runIndex + 1}  ${p.config.taskLabel}`;
		const cacheFlag = p.statsA.totalCacheRead + p.statsB.totalCacheRead > 0 ? " \x1b[33m[C]\x1b[0m" : "";
		console.log(
			`  ${pad(taskStr, taskCol)}  ${orderLabel.padEnd(10)}  ${`${p.statsA.totalEnergy.toFixed(0)}J`.padEnd(10)}  ${`${p.statsB.totalEnergy.toFixed(0)}J`.padEnd(10)}  ${`${savedPct.toFixed(0)}%`.padEnd(8)}  ${qualLabel}${cacheFlag}`,
		);
	}

	const fmtTime = (s: number) => `${s.toFixed(0)}s`;
	console.log(
		`  ${"─".repeat(taskCol)}  ${"─".repeat(10)}  ${"─".repeat(10)}  ${"─".repeat(10)}  ${"─".repeat(8)}  ───────`,
	);
	console.log(
		`  ${"passed".padEnd(taskCol)}  ${"".padEnd(10)}  ${"".padEnd(10)}  ${"".padEnd(10)}  ${"".padEnd(8)}  ${aPassed}/${pairs.length} / ${bPassed}/${pairs.length}`,
	);

	if (nPassed > 0) {
		const avgLabel = nPassed < pairs.length ? `avg (${nPassed}/${pairs.length} all-pass)` : "avg";
		console.log(
			`  ${avgLabel.padEnd(taskCol)}  ${"".padEnd(10)}  ${`${avgAEnergy.toFixed(0)}J`.padEnd(10)}  ${`${avgBEnergy.toFixed(0)}J`.padEnd(10)}  ${`${avgSavedPct.toFixed(0)}%`.padEnd(8)}`,
		);
		console.log(
			`  ${"est. cost".padEnd(taskCol)}  ${"".padEnd(10)}  ${`$${avgACost.toFixed(4)}`.padEnd(10)}  ${`$${avgBCost.toFixed(4)}`.padEnd(10)}  ${`${avgCostSavedPct.toFixed(0)}%`.padEnd(8)}`,
		);
		console.log(
			`  ${"wall time".padEnd(taskCol)}  ${"".padEnd(10)}  ${fmtTime(avgATime).padEnd(10)}  ${fmtTime(avgBTime).padEnd(10)}  ${`${avgTimeDiffPct.toFixed(0)}%`.padEnd(8)}`,
		);
	}

	console.log(`${"═".repeat(tableWidth)}`);

	if (nPassed === 0) {
		console.log(`\n  \x1b[31mNo runs where both models passed — no averages to compare.\x1b[0m`);
	} else {
		if (nPassed < pairs.length) {
			const skipped = pairs.length - nPassed;
			console.log(
				`\n  \x1b[33m${skipped} run${skipped !== 1 ? "s" : ""} excluded — only runs where both models passed are counted in averages.\x1b[0m`,
			);
		}
		if (avgSavedPct > 0) {
			console.log(
				`  \x1b[32m✓ Model B (${modelB.name}) averages ${avgSavedPct.toFixed(0)}% less energy, ${avgCostSavedPct.toFixed(0)}% lower cost\x1b[0m`,
			);
		} else if (avgSavedPct < 0) {
			console.log(
				`  \x1b[33m→ Model A (${modelA.name}) averages ${Math.abs(avgSavedPct).toFixed(0)}% less energy, ${Math.abs(avgCostSavedPct).toFixed(0)}% lower cost\x1b[0m`,
			);
		} else {
			console.log(`  → Models used equal energy on average`);
		}
	}
}

// -- Main ---------------------------------------------------------------------

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			budget: { type: "string", default: String(DEFAULT_BUDGET_JOULES) },
			task: { type: "string" },
			acceptance: { type: "string" },
			static: { type: "boolean", default: false },
			reverse: { type: "boolean", default: false },
			runs: { type: "string", default: "1" },
			hard: { type: "boolean", default: false },
			"model-a": { type: "string", default: "moonshotai/Kimi-K2.5" },
			"model-b": { type: "string", default: "neuralwatt/kimi-k2.5-long" },
		},
		allowPositionals: true,
	});

	if (!process.env.NEURALWATT_API_KEY) {
		console.error("NEURALWATT_API_KEY required");
		process.exit(1);
	}

	registerBuiltInApiProviders();

	const apiKey = process.env.NEURALWATT_API_KEY;
	const budgetJ = Number(values.budget);
	const numRuns = Math.max(1, parseInt(values.runs ?? "1", 10));
	const startBFirst = values.reverse ?? false;
	const enableHard = values.hard ?? false;

	const modelA = resolveModel(values["model-a"]!);
	const modelB = resolveModel(values["model-b"]!);

	// Startup banner
	console.log("╔══════════════════════════════════════════════════════════════════════╗");
	console.log("║                    Model Comparison Demo                            ║");
	console.log(`║  Model A: ${modelA.name.padEnd(58)}║`);
	console.log(`║           ${modelA.id.padEnd(58)}║`);
	console.log(`║  Model B: ${modelB.name.padEnd(58)}║`);
	console.log(`║           ${modelB.id.padEnd(58)}║`);
	console.log(`║  Budget:  ${`${budgetJ}J (display)`.padEnd(58)}║`);
	console.log(`║  Runs:    ${`${numRuns}`.padEnd(58)}║`);
	if (values.task) {
		console.log(`║  Task:    ${(values.task as string).slice(0, 58).padEnd(58)}║`);
	} else if (values.static) {
		console.log(`║  Task:    ${"hardcoded rate-limiter (--static)".padEnd(58)}║`);
	} else {
		const diffLabel = enableHard
			? "LLM-generated per run (--hard: hard only)"
			: "LLM-generated per run (fresh challenge each time)";
		console.log(`║  Task:    ${diffLabel.padEnd(58)}║`);
	}
	console.log("╠══════════════════════════════════════════════════════════════════════╣");
	console.log("║  Flags:  --model-a <id> --model-b <id> --runs N --reverse          ║");
	console.log("║          --budget N --static --hard --task <str> --acceptance <path> ║");
	console.log("╚══════════════════════════════════════════════════════════════════════╝");

	// Run loop
	const pairs: RunPair[] = [];

	for (let i = 0; i < numRuns; i++) {
		const order: "a-first" | "b-first" = (i % 2 === 0) !== startBFirst ? "a-first" : "b-first";
		const orderArrow = order === "a-first" ? "Model A → Model B" : "Model B → Model A";

		if (numRuns > 1) {
			console.log(`\n${"─".repeat(70)}`);
			console.log(`  Run ${i + 1}/${numRuns}  (${orderArrow})`);
			console.log(`${"─".repeat(70)}`);
		}

		const config = await buildRunConfig(
			values.static ?? false,
			values.task,
			values.acceptance,
			modelA,
			apiKey,
			enableHard,
		);

		let statsA: RunStats;
		let statsB: RunStats;

		try {
			if (order === "a-first") {
				statsA = await runModel("Model A", modelA, config, apiKey, budgetJ);
				statsB = await runModel("Model B", modelB, config, apiKey, budgetJ);
			} else {
				statsB = await runModel("Model B", modelB, config, apiKey, budgetJ);
				statsA = await runModel("Model A", modelA, config, apiKey, budgetJ);
			}

			const runLabel = numRuns > 1 ? `(Run ${i + 1}/${numRuns})` : "";
			printScorecard(statsA, statsB, config, budgetJ, runLabel);

			pairs.push({ runIndex: i, order, config, statsA, statsB });
		} catch (err) {
			console.error(
				`\n  \x1b[31m✗ Run ${i + 1}/${numRuns} failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
			);
			if (numRuns === 1) throw err;
			console.log("  Skipping to next run…\n");
		}
	}

	if (numRuns > 1) {
		printAggregateScorecard(pairs, modelA, modelB);
	}
}

main().catch((err) => {
	console.error("Demo failed:", err);
	process.exit(1);
});
