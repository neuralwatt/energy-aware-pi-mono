/**
 * Timing Breakdown Extension
 *
 * Tracks wall-clock time, token throughput, cache efficiency, context size,
 * energy usage, and tool output sizes — everything needed to identify
 * optimization targets.
 *
 * Assumes Neuralwatt provider endpoints that return energy telemetry
 * (energy_joules, energy_kwh, duration_seconds) in the usage object.
 *
 * Commands:
 *   /timing        — Show timing summary for the last prompt
 *   /timing full   — Show detailed per-turn and per-tool breakdown
 *   /timing opt    — Show optimization opportunities analysis
 *   /timing reset  — Clear accumulated timing data
 *   /timing watch  — Toggle auto-display after each agent_end
 *   /timing footer — Toggle live timing in footer
 */

import type { AssistantMessage, EnergyUsage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Types ──────────────────────────────────────────────────────────

interface RequestTiming {
	start: number; // Date.now() at before_provider_request
	ttfb?: number; // ms to first byte (after_provider_response)
	end: number; // Date.now() when assistant message_end fires
	turnIndex: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costTotal: number;
	energy?: EnergyUsage;
	model: string;
	responseModel?: string;
	status?: number; // HTTP status from after_provider_response
	retryCount: number;
	wasRateLimited: boolean;
	diagnosticsCount: number;
}

interface ToolTiming {
	toolCallId: string;
	name: string;
	start: number;
	end: number;
	isError: boolean;
	turnIndex: number;
	outputSize: number; // bytes of tool result content
	argsSummary: string; // short description of args for optimization hints
}

interface TurnTiming {
	index: number;
	start: number;
	end: number;
	requestStart?: number;
	requestTtfb?: number;
	requestEnd?: number;
	tools: ToolTiming[];
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

interface CompactionTiming {
	timestamp: number;
	tokensBefore: number;
}

interface PromptTiming {
	promptStart: number;
	promptEnd: number;
	turns: TurnTiming[];
	requests: RequestTiming[];
	tools: ToolTiming[];
	compactions: CompactionTiming[];
	// Context size snapshot from each context event
	contextSizes: { turnIndex: number; messageCount: number; timestamp: number }[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function fmt(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60_000);
	const secs = Math.round((ms % 60_000) / 1000);
	return `${mins}m${secs}s`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function pct(part: number, whole: number): string {
	if (whole === 0) return "0%";
	return `${Math.round((part / whole) * 100)}%`;
}

function bar(part: number, whole: number, width = 20): string {
	if (whole === 0) return "░".repeat(width);
	const filled = Math.round((part / whole) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtEnergy(energy?: EnergyUsage): string {
	if (!energy) return "";
	const j = energy.energy_joules;
	if (j < 1) return `${(j * 1000).toFixed(0)}mJ`;
	if (j < 1000) return `${j.toFixed(1)}J`;
	return `${(j / 1000).toFixed(2)}kJ`;
}

function fmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function contentSize(content: unknown): number {
	if (typeof content === "string") return Buffer.byteLength(content, "utf8");
	if (Array.isArray(content)) {
		return content.reduce((sum: number, block: any) => {
			if (block.type === "text") return sum + Buffer.byteLength(block.text || "", "utf8");
			if (block.type === "image") return sum + (block.data?.length || 0) * 0.75; // base64 ≈ 75% overhead
			return sum;
		}, 0);
	}
	return 0;
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let current: PromptTiming | null = null;
	let history: PromptTiming[] = [];
	let autoShow = false;
	let footerEnabled = false;
	let currentTurnIndex = 0;

	// Track per-turn request state for matching message_end to request
	const pendingRequests = new Map<number, RequestTiming>();
	// Track retries by counting duplicate before_provider_request per turn
	const requestCountPerTurn = new Map<number, number>();
	// Track rate limit responses
	const rateLimitedTurns = new Set<number>();
	// Track tool output sizes from tool_result events
	const toolOutputSizes = new Map<string, number>();

	// ── Agent lifecycle ──

	pi.on("agent_start", async () => {
		current = {
			promptStart: Date.now(),
			promptEnd: 0,
			turns: [],
			requests: [],
			tools: [],
			compactions: [],
			contextSizes: [],
		};
		currentTurnIndex = 0;
		pendingRequests.clear();
		requestCountPerTurn.clear();
		rateLimitedTurns.clear();
		toolOutputSizes.clear();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!current) return;
		current.promptEnd = Date.now();
		history.push(current);
		if (history.length > 50) history = history.slice(-50);
		if (autoShow) {
			ctx.ui.notify(formatSummary(current), "info");
		}
	});

	// ── Turn tracking ──

	pi.on("turn_start", async (event) => {
		if (!current) return;
		currentTurnIndex = event.turnIndex ?? current.turns.length;
		current.turns.push({
			index: currentTurnIndex,
			start: Date.now(),
			end: 0,
			tools: [],
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
	});

	pi.on("turn_end", async (_event) => {
		if (!current) return;
		const turn = current.turns.find((t) => t.index === currentTurnIndex);
		if (turn) turn.end = Date.now();
	});

	// ── Context size estimation ──

	pi.on("context", async (event) => {
		if (!current) return;
		current.contextSizes.push({
			turnIndex: currentTurnIndex,
			messageCount: event.messages.length,
			timestamp: Date.now(),
		});
	});

	// ── Provider request tracking ──

	pi.on("before_provider_request", async () => {
		if (!current) return;
		const start = Date.now();
		const existingCount = requestCountPerTurn.get(currentTurnIndex) ?? 0;
		requestCountPerTurn.set(currentTurnIndex, existingCount + 1);

		const req: RequestTiming = {
			start,
			end: 0,
			turnIndex: currentTurnIndex,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costTotal: 0,
			model: "",
			retryCount: existingCount, // If this is the 2nd+ request for this turn, it's a retry
			wasRateLimited: rateLimitedTurns.has(currentTurnIndex),
			diagnosticsCount: 0,
		};
		current.requests.push(req);
		pendingRequests.set(currentTurnIndex, req);
	});

	pi.on("after_provider_response", async (event) => {
		if (!current) return;
		const now = Date.now();
		const req = pendingRequests.get(currentTurnIndex);
		if (req) {
			req.ttfb = now - req.start;
			req.status = event.status;
		}
		const turn = current.turns.find((t) => t.index === currentTurnIndex);
		if (turn && req) {
			turn.requestStart = req.start;
			turn.requestTtfb = req.ttfb;
		}
		// Track rate limits for next request in this turn
		if (event.status === 429) {
			rateLimitedTurns.add(currentTurnIndex);
		}
	});

	pi.on("message_end", async (event) => {
		if (!current) return;
		if (event.message.role !== "assistant") return;
		const msg = event.message as AssistantMessage;
		const now = Date.now();

		// Close the request for this turn
		const req = pendingRequests.get(currentTurnIndex);
		if (req) {
			req.end = now;
			req.inputTokens = msg.usage.input;
			req.outputTokens = msg.usage.output;
			req.cacheReadTokens = msg.usage.cacheRead;
			req.cacheWriteTokens = msg.usage.cacheWrite;
			req.costTotal = msg.usage.cost.total;
			req.energy = msg.energy;
			req.model = msg.model;
			req.responseModel = msg.responseModel;
			req.diagnosticsCount = msg.diagnostics?.length ?? 0;
			pendingRequests.delete(currentTurnIndex);
		}

		// Update turn token/energy summary
		const turn = current.turns.find((t) => t.index === currentTurnIndex);
		if (turn) {
			turn.requestEnd = now;
			turn.inputTokens += msg.usage.input;
			turn.outputTokens += msg.usage.output;
			turn.cacheReadTokens += msg.usage.cacheRead;
			turn.cacheWriteTokens += msg.usage.cacheWrite;
		}
	});

	// ── Tool execution tracking ──

	pi.on("tool_execution_start", async (event) => {
		if (!current) return;
		const argsSummary = formatArgsSummary(event.toolName, event.args);
		const t: ToolTiming = {
			toolCallId: event.toolCallId,
			name: event.toolName,
			start: Date.now(),
			end: 0,
			isError: false,
			turnIndex: currentTurnIndex,
			outputSize: 0,
			argsSummary,
		};
		current.tools.push(t);
		const turn = current.turns.find((t) => t.index === currentTurnIndex);
		if (turn) turn.tools.push(t);
	});

	pi.on("tool_execution_end", async (event) => {
		if (!current) return;
		const t = current.tools.find((t) => t.toolCallId === event.toolCallId && t.end === 0);
		if (t) {
			t.end = Date.now();
			t.isError = event.isError;
		}
		// Capture output size from result
		const existingSize = toolOutputSizes.get(event.toolCallId) ?? 0;
		if (t) t.outputSize = existingSize || contentSize(event.result);
	});

	// Also capture output size from tool_result events (more accurate content sizing)
	pi.on("tool_result", async (event) => {
		const size = contentSize(event.content);
		toolOutputSizes.set(event.toolCallId, size);
		// Backfill the tool timing if it exists
		if (current) {
			const t = current.tools.find((t) => t.toolCallId === event.toolCallId);
			if (t) t.outputSize = size;
		}
	});

	// ── Compaction tracking ──

	pi.on("session_compact", async (event) => {
		if (!current) return;
		current.compactions.push({
			timestamp: Date.now(),
			tokensBefore: event.compactionEntry.tokensBefore,
		});
	});

	// ── Args summary for optimization hints ──

	function formatArgsSummary(toolName: string, args: any): string {
		try {
			switch (toolName) {
				case "bash":
					return String(args.command || "").slice(0, 60);
				case "read":
					return String(args.file_path || args.path || "");
				case "write":
					return `${String(args.file_path || args.path || "")} (${String(args.content || "").split("\n").length} lines)`;
				case "edit":
					return String(args.file_path || args.path || "");
				default:
					return "";
			}
		} catch {
			return "";
		}
	}

	// ══════════════════════════════════════════════════════════════════
	// Formatting
	// ══════════════════════════════════════════════════════════════════

	function formatSummary(t: PromptTiming): string {
		const total = t.promptEnd - t.promptStart;
		if (total === 0) return "No timing data";

		const llmTime = t.requests.reduce((s, r) => s + (r.end - r.start), 0);
		const toolTime = t.tools.reduce((s, r) => s + (r.end - r.start), 0);
		const overhead = total - llmTime - toolTime;
		const totalInput = t.requests.reduce((s, r) => s + r.inputTokens, 0);
		const totalOutput = t.requests.reduce((s, r) => s + r.outputTokens, 0);
		const totalCacheRead = t.requests.reduce((s, r) => s + r.cacheReadTokens, 0);
		const totalCacheWrite = t.requests.reduce((s, r) => s + r.cacheWriteTokens, 0);
		const totalCost = t.requests.reduce((s, r) => s + r.costTotal, 0);
		const totalEnergy = t.requests.reduce((s, r) => s + (r.energy?.energy_joules ?? 0), 0);
		const cacheHitRate = totalCacheRead > 0 ? Math.round((totalCacheRead / (totalInput || 1)) * 100) : 0;
		const outputTokPerSec = llmTime > 0 ? Math.round(totalOutput / (llmTime / 1000)) : 0;
		const retries = t.requests.filter((r) => r.retryCount > 0).length;
		const rateLimits = t.requests.filter((r) => r.wasRateLimited).length;

		const lines: string[] = [];
		lines.push(
			`⏱  ${fmt(total)} total │ ${fmt(llmTime)} LLM (${pct(llmTime, total)}) │ ${fmt(toolTime)} tools (${pct(toolTime, total)}) │ ${fmt(overhead)} overhead (${pct(overhead, total)})`,
		);
		lines.push(
			`   ${t.turns.length} turn${t.turns.length !== 1 ? "s" : ""} │ ${t.tools.length} tool call${t.tools.length !== 1 ? "s" : ""} │ ${fmtTokens(totalInput)} in │ ${fmtTokens(totalOutput)} out │ ${outputTokPerSec > 0 ? `${outputTokPerSec} tok/s` : "—"} out`,
		);

		if (totalCacheRead > 0 || totalCacheWrite > 0) {
			lines.push(
				`   Cache: ${fmtTokens(totalCacheRead)} read (${cacheHitRate}% hit) │ ${fmtTokens(totalCacheWrite)} write`,
			);
		}
		if (totalCost > 0) lines.push(`   Cost: $${totalCost.toFixed(4)}`);
		if (totalEnergy > 0)
			lines.push(
				`   Energy: ${fmtEnergy({ energy_joules: totalEnergy, energy_kwh: totalEnergy / 3_600_000, duration_seconds: 0 })}`,
			);
		if (retries > 0) lines.push(`   ⚠ Retries: ${retries}`);
		if (rateLimits > 0) lines.push(`   ⚠ Rate limited: ${rateLimits}`);
		if (t.compactions.length > 0)
			lines.push(
				`   🗜 Compactions: ${t.compactions.length} (last: ${fmtTokens(t.compactions[t.compactions.length - 1].tokensBefore)} before)`,
			);
		const totalToolOutput = t.tools.reduce((s, t) => s + t.outputSize, 0);
		if (totalToolOutput > 10 * 1024) {
			lines.push(`   📦 Tool output: ${fmtBytes(totalToolOutput)}`);
		}

		return lines.join("\n");
	}

	function formatFull(t: PromptTiming): string {
		const total = t.promptEnd - t.promptStart;
		if (total === 0) return "No timing data";

		const llmTime = t.requests.reduce((s, r) => s + (r.end - r.start), 0);
		const toolTime = t.tools.reduce((s, r) => s + (r.end - r.start), 0);
		const overhead = Math.max(0, total - llmTime - toolTime);
		const totalInput = t.requests.reduce((s, r) => s + r.inputTokens, 0);
		const totalOutput = t.requests.reduce((s, r) => s + r.outputTokens, 0);
		const totalCacheRead = t.requests.reduce((s, r) => s + r.cacheReadTokens, 0);
		const totalCacheWrite = t.requests.reduce((s, r) => s + r.cacheWriteTokens, 0);
		const totalCost = t.requests.reduce((s, r) => s + r.costTotal, 0);
		const totalEnergy = t.requests.reduce((s, r) => s + (r.energy?.energy_joules ?? 0), 0);
		const cacheHitRate = totalCacheRead > 0 ? Math.round((totalCacheRead / (totalInput || 1)) * 100) : 0;
		const outputTokPerSec = llmTime > 0 ? Math.round(totalOutput / (llmTime / 1000)) : 0;

		const lines: string[] = [];

		// ── Header ──
		lines.push("");
		lines.push("╭──────────────────────────────────────────────────────────╮");
		lines.push("│  TIMING BREAKDOWN                                        │");
		lines.push("╰──────────────────────────────────────────────────────────╯");
		lines.push("");
		lines.push(`  Total: ${fmt(total)}`);
		lines.push("");
		lines.push(`  LLM requests  ${bar(llmTime, total)}  ${fmt(llmTime)} (${pct(llmTime, total)})`);
		lines.push(`  Tool calls     ${bar(toolTime, total)}  ${fmt(toolTime)} (${pct(toolTime, total)})`);
		lines.push(`  Overhead       ${bar(overhead, total)}  ${fmt(overhead)} (${pct(overhead, total)})`);
		lines.push("");

		// ── Token & cost summary ──
		lines.push("  ── Tokens & Cost ────────────────────────────────────────");
		lines.push("");
		lines.push(`  Input:   ${fmtTokens(totalInput)}`);
		lines.push(`  Output:  ${fmtTokens(totalOutput)}  (${outputTokPerSec} tok/s)`);
		if (totalCacheRead > 0 || totalCacheWrite > 0) {
			lines.push(
				`  Cache:   ${fmtTokens(totalCacheRead)} read (${cacheHitRate}% hit) │ ${fmtTokens(totalCacheWrite)} write`,
			);
		}
		if (totalCost > 0) lines.push(`  Cost:    $${totalCost.toFixed(4)}`);
		if (totalEnergy > 0) {
			lines.push(
				`  Energy:  ${fmtEnergy({ energy_joules: totalEnergy, energy_kwh: totalEnergy / 3_600_000, duration_seconds: 0 })}`,
			);
		}
		const totalToolOutput = t.tools.reduce((s, tool) => s + tool.outputSize, 0);
		if (totalToolOutput > 0) lines.push(`  Tool output size: ${fmtBytes(totalToolOutput)}`);
		lines.push("");

		// ── Per-turn breakdown ──
		if (t.turns.length > 0) {
			lines.push("  ── Per Turn ─────────────────────────────────────────────");
			lines.push("");
			for (const turn of t.turns) {
				const turnTotal = (turn.end || t.promptEnd) - turn.start;
				const turnLlm =
					turn.requestStart != null && turn.requestEnd != null ? turn.requestEnd - turn.requestStart : 0;
				const turnTool = turn.tools.reduce((s, tool) => s + (tool.end - tool.start), 0);
				const turnOverhead = turnTotal - turnLlm - turnTool;

				// Token throughput for this turn
				const turnOutPerSec = turnLlm > 0 ? Math.round(turn.outputTokens / (turnLlm / 1000)) : 0;
				const turnCacheRate =
					turn.inputTokens > 0 ? Math.round((turn.cacheReadTokens / turn.inputTokens) * 100) : 0;

				lines.push(`  Turn ${turn.index + 1}: ${fmt(turnTotal)}`);
				lines.push(`    LLM: ${fmt(turnLlm)}${turn.requestTtfb ? ` (TTFB: ${fmt(turn.requestTtfb)})` : ""}`);
				lines.push(
					`    Tokens: ${fmtTokens(turn.inputTokens)} in │ ${fmtTokens(turn.outputTokens)} out (${turnOutPerSec} tok/s)`,
				);
				if (turn.cacheReadTokens > 0) {
					lines.push(
						`    Cache: ${fmtTokens(turn.cacheReadTokens)} read (${turnCacheRate}% hit) │ ${fmtTokens(turn.cacheWriteTokens)} write`,
					);
				}
				lines.push(`    Tools: ${fmt(turnTool)} (${turn.tools.length} call${turn.tools.length !== 1 ? "s" : ""})`);
				if (turnOverhead > 100) {
					lines.push(`    Overhead: ${fmt(turnOverhead)}`);
				}

				// Per-tool detail
				if (turn.tools.length > 0) {
					const toolGroups = new Map<
						string,
						{ count: number; time: number; errors: number; outputBytes: number }
					>();
					for (const tool of turn.tools) {
						const g = toolGroups.get(tool.name) || { count: 0, time: 0, errors: 0, outputBytes: 0 };
						g.count++;
						g.time += tool.end - tool.start;
						if (tool.isError) g.errors++;
						g.outputBytes += tool.outputSize;
						toolGroups.set(tool.name, g);
					}
					const parts = Array.from(toolGroups.entries())
						.sort((a, b) => b[1].time - a[1].time)
						.map(([name, g]) => {
							let s = `${name}×${g.count}: ${fmt(g.time)}`;
							if (g.outputBytes > 1024) s += ` (${fmtBytes(g.outputBytes)} out)`;
							if (g.errors > 0) s += ` (${g.errors} err)`;
							return s;
						});
					lines.push(`    [${parts.join(", ")}]`);
				}
				lines.push("");
			}
		}

		// ── All-time tool summary ──
		if (t.tools.length > 0) {
			lines.push("  ── All Tool Calls ───────────────────────────────────────");
			lines.push("");
			const toolGroups = new Map<
				string,
				{ count: number; totalTime: number; min: number; max: number; errors: number; totalOutputBytes: number }
			>();
			for (const tool of t.tools) {
				const elapsed = tool.end - tool.start;
				const g = toolGroups.get(tool.name) || {
					count: 0,
					totalTime: 0,
					min: Infinity,
					max: 0,
					errors: 0,
					totalOutputBytes: 0,
				};
				g.count++;
				g.totalTime += elapsed;
				g.min = Math.min(g.min, elapsed);
				g.max = Math.max(g.max, elapsed);
				if (tool.isError) g.errors++;
				g.totalOutputBytes += tool.outputSize;
				toolGroups.set(tool.name, g);
			}

			const maxName = Math.max(...Array.from(toolGroups.keys()).map((n) => n.length), 4);
			for (const [name, g] of toolGroups) {
				const avg = g.totalTime / g.count;
				const errStr = g.errors > 0 ? `  (${g.errors} err)` : "";
				const outStr = g.totalOutputBytes > 1024 ? `  out ${fmtBytes(g.totalOutputBytes)}` : "";
				lines.push(
					`  ${name.padEnd(maxName)}  ${bar(g.totalTime, total, 12)}  total ${fmt(g.totalTime)}  avg ${fmt(avg)}  min ${fmt(g.min)}  max ${fmt(g.max)}  ×${g.count}${outStr}${errStr}`,
				);
			}
			lines.push("");
		}

		// ── LLM Request details ──
		if (t.requests.length > 0) {
			lines.push("  ── LLM Requests ────────────────────────────────────────");
			lines.push("");
			for (let i = 0; i < t.requests.length; i++) {
				const r = t.requests[i];
				const dur = r.end - r.start;
				const reqOutPerSec = dur > 0 ? Math.round(r.outputTokens / (dur / 1000)) : 0;
				const cacheRate = r.inputTokens > 0 ? Math.round((r.cacheReadTokens / r.inputTokens) * 100) : 0;
				const ttfbStr = r.ttfb != null ? `  TTFB: ${fmt(r.ttfb)}` : "";
				const modelStr = r.responseModel && r.responseModel !== r.model ? `  (${r.responseModel})` : "";
				const retryStr = r.retryCount > 0 ? `  ⚠ retry #${r.retryCount}` : "";
				const rateLimitStr = r.wasRateLimited ? "  ⚠ rate-limited" : "";
				const statusStr = r.status ? `  HTTP ${r.status}` : "";

				lines.push(
					`  Request ${i + 1} (turn ${r.turnIndex + 1}): ${fmt(dur)}${ttfbStr}${modelStr}${retryStr}${rateLimitStr}${statusStr}`,
				);
				lines.push(
					`    ${fmtTokens(r.inputTokens)} in │ ${fmtTokens(r.outputTokens)} out (${reqOutPerSec} tok/s) │ cache ${cacheRate}% hit`,
				);
				if (r.costTotal > 0) lines.push(`    Cost: $${r.costTotal.toFixed(4)}`);
				if (r.energy)
					lines.push(`    Energy: ${fmtEnergy(r.energy)} (${r.energy.duration_seconds.toFixed(1)}s GPU)`);
				if (r.diagnosticsCount > 0) lines.push(`    Diagnostics: ${r.diagnosticsCount}`);
			}
			const avgTtfb = t.requests.reduce((s, r) => s + (r.ttfb ?? 0), 0) / t.requests.length;
			const avgDur = t.requests.reduce((s, r) => s + (r.end - r.start), 0) / t.requests.length;
			lines.push("");
			lines.push(`  Avg request: ${fmt(avgDur)}  Avg TTFB: ${fmt(avgTtfb)}  Avg out: ${outputTokPerSec} tok/s`);
			lines.push("");
		}

		// ── Compaction events ──
		if (t.compactions.length > 0) {
			lines.push("  ── Compactions ─────────────────────────────────────────");
			lines.push("");
			for (const c of t.compactions) {
				lines.push(
					`  Compacted at ${new Date(c.timestamp).toISOString()}: ${fmtTokens(c.tokensBefore)} tokens before`,
				);
			}
			lines.push("");
		}

		// ── Context growth ──
		if (t.contextSizes.length > 1) {
			lines.push("  ── Context Growth ───────────────────────────────────────");
			lines.push("");
			for (const cs of t.contextSizes) {
				lines.push(`  Turn ${cs.turnIndex + 1}: ${cs.messageCount} messages`);
			}
			lines.push("");
		}

		return lines.join("\n");
	}

	// ══════════════════════════════════════════════════════════════════
	// Optimization Analysis
	// ══════════════════════════════════════════════════════════════════

	function formatOptimization(t: PromptTiming): string {
		const total = t.promptEnd - t.promptStart;
		if (total === 0) return "No timing data";

		const llmTime = t.requests.reduce((s, r) => s + (r.end - r.start), 0);
		const toolTime = t.tools.reduce((s, r) => s + (r.end - r.start), 0);
		const totalInput = t.requests.reduce((s, r) => s + r.inputTokens, 0);
		const totalOutput = t.requests.reduce((s, r) => s + r.outputTokens, 0);
		const totalCacheRead = t.requests.reduce((s, r) => s + r.cacheReadTokens, 0);
		const totalCacheWrite = t.requests.reduce((s, r) => s + r.cacheWriteTokens, 0);
		const totalCost = t.requests.reduce((s, r) => s + r.costTotal, 0);
		const totalEnergy = t.requests.reduce((s, r) => s + (r.energy?.energy_joules ?? 0), 0);
		const cacheHitRate = totalInput > 0 ? Math.round((totalCacheRead / totalInput) * 100) : 0;
		const outputTokPerSec = llmTime > 0 ? Math.round(totalOutput / (llmTime / 1000)) : 0;
		const avgTtfb = t.requests.length > 0 ? t.requests.reduce((s, r) => s + (r.ttfb ?? 0), 0) / t.requests.length : 0;

		const findings: { severity: "critical" | "warning" | "info"; icon: string; title: string; detail: string }[] = [];

		// ── Context bloat ──
		if (totalInput > 50_000 && cacheHitRate < 50) {
			findings.push({
				severity: "critical",
				icon: "🔥",
				title: "Large context with poor cache hit rate",
				detail: `Sending ${fmtTokens(totalInput)} input tokens with only ${cacheHitRate}% cache hits. Each turn re-sends most tokens at full cost. Consider:\n    • Reduce tool output sizes (add truncation)\n    • Compact earlier to shrink context\n    • Structure prompts for cache alignment (static prefix, dynamic suffix)`,
			});
		} else if (totalInput > 100_000) {
			findings.push({
				severity: "warning",
				icon: "⚠️",
				title: "Very large context window",
				detail: `${fmtTokens(totalInput)} input tokens per request. Even with ${cacheHitRate}% cache hits, this drives TTFB and cost. Consider compacting or reducing verbose tool output.`,
			});
		}

		// ── Cache optimization ──
		if (totalCacheWrite > 0 && cacheHitRate < 30 && totalInput > 10_000) {
			findings.push({
				severity: "warning",
				icon: "💾",
				title: "Low cache efficiency",
				detail: `${fmtTokens(totalCacheWrite)} tokens written to cache but only ${cacheHitRate}% hit rate. Cache writes are wasted if subsequent turns re-read different prefixes. Ensure system prompt and early messages remain stable across turns.`,
			});
		}

		// ── Tool output bloat ──
		const largeToolOutputs = t.tools.filter((tool) => tool.outputSize > 10 * 1024);
		if (largeToolOutputs.length > 0) {
			const totalBloat = largeToolOutputs.reduce((s, tool) => s + tool.outputSize, 0);
			const examples = largeToolOutputs.slice(0, 3).map((tool) => `${tool.name} (${fmtBytes(tool.outputSize)})`);
			findings.push({
				severity: "warning",
				icon: "📦",
				title: "Tool outputs inflating context",
				detail: `${largeToolOutputs.length} tool call${largeToolOutputs.length > 1 ? "s" : ""} produced ${fmtBytes(totalBloat)} of output that gets fed back as input next turn: ${examples.join(", ")}\n    Consider: truncating output, using offset/limit on reads, or piping through grep/head.`,
			});
		}

		// ── Slow TTFB ──
		if (avgTtfb > 3000 && totalInput > 20_000) {
			findings.push({
				severity: "warning",
				icon: "🐢",
				title: "High TTFB — likely caused by large context",
				detail: `Average TTFB: ${fmt(avgTtfb)}. With ${fmtTokens(totalInput)} input tokens, prefill is the bottleneck. Reducing context size will directly lower TTFB.`,
			});
		} else if (avgTtfb > 5000) {
			findings.push({
				severity: "warning",
				icon: "🐢",
				title: "High TTFB",
				detail: `Average TTFB: ${fmt(avgTtfb)} even with moderate context. This may indicate provider-side queueing, model load, or network latency. Check model throughput metric.`,
			});
		}

		// ── Low output throughput ──
		if (outputTokPerSec > 0 && outputTokPerSec < 20 && totalOutput > 500) {
			findings.push({
				severity: "warning",
				icon: "📝",
				title: "Low output token throughput",
				detail: `${outputTokPerSec} tok/s output. This may indicate the model is running on oversized weights, a loaded GPU, or a slow provider. Consider a smaller/faster model for routine tasks.`,
			});
		}

		// ── LLM vs tool time imbalance ──
		if (toolTime > llmTime && total > 5000) {
			findings.push({
				severity: "info",
				icon: "🔧",
				title: "Tool time exceeds LLM time",
				detail: `${fmt(toolTime)} in tools vs ${fmt(llmTime)} in LLM. Slow tools dominate your latency. Profile individual tools to find optimization targets.`,
			});
		}

		// ── Retries and rate limits ──
		const retries = t.requests.filter((r) => r.retryCount > 0);
		const rateLimits = t.requests.filter((r) => r.wasRateLimited);
		if (rateLimits.length > 0) {
			findings.push({
				severity: "critical",
				icon: "🚦",
				title: "Rate limiting detected",
				detail: `${rateLimits.length} request${rateLimits.length > 1 ? "s" : ""} hit rate limits. This adds retry latency and cost. Consider:\n    • Lower thinking level to reduce output tokens\n    • Use a model with higher rate limits\n    • Reduce parallel tool calls that trigger sub-requests`,
			});
		}
		if (retries.length > 0) {
			findings.push({
				severity: "warning",
				icon: "🔄",
				title: "Request retries",
				detail: `${retries.length} request${retries.length > 1 ? "s" : ""} required retries. Total retry overhead: ${fmt(retries.reduce((s, r) => s + r.retryCount, 0) * avgTtfb)}. Check provider diagnostics.`,
			});
		}

		// ── Excessive turns ──
		if (t.turns.length > 5) {
			findings.push({
				severity: "info",
				icon: "🔁",
				title: "Many turns per prompt",
				detail: `${t.turns.length} turns for this prompt. Each turn sends the full context again. Consider prompting the model to batch tool calls or reduce round-trips.`,
			});
		}

		// ── Compaction frequency ──
		if (t.compactions.length > 1) {
			findings.push({
				severity: "info",
				icon: "🗜",
				title: "Frequent compaction",
				detail: `${t.compactions.length} compactions during this prompt. Context is growing fast — likely from verbose tool output. Each compaction itself costs an LLM call.`,
			});
		}

		// ── Energy per token ──
		if (totalEnergy > 0 && totalOutput > 0) {
			const joulesPerTok = totalEnergy / totalOutput;
			if (joulesPerTok > 1.0) {
				findings.push({
					severity: "info",
					icon: "⚡",
					title: "High energy per output token",
					detail: `${joulesPerTok.toFixed(2)} J/token. This is above baseline — GPU may not be power-optimized for this load. Check neuralwatt_agent Q-learning policy.`,
				});
			}
		}

		// ── Render ──
		const lines: string[] = [];
		lines.push("");
		lines.push("╭──────────────────────────────────────────────────────────╮");
		lines.push("│  OPTIMIZATION ANALYSIS                                    │");
		lines.push("╰──────────────────────────────────────────────────────────╯");
		lines.push("");

		if (findings.length === 0) {
			lines.push("  ✅ No obvious optimization targets detected.");
			lines.push(
				`     ${fmt(total)} total │ ${fmtTokens(totalInput)} in │ ${outputTokPerSec} tok/s out │ ${cacheHitRate}% cache hit`,
			);
			lines.push("");
			return lines.join("\n");
		}

		// Sort by severity
		const severityOrder = { critical: 0, warning: 1, info: 2 } as const;
		findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

		for (const f of findings) {
			lines.push(`  ${f.icon}  ${f.title} [${f.severity.toUpperCase()}]`);
			for (const line of f.detail.split("\n")) {
				lines.push(`     ${line}`);
			}
			lines.push("");
		}

		// ── Quick stats ──
		lines.push("  ── Quick Stats ──────────────────────────────────────────");
		lines.push("");
		lines.push(`  Total time:    ${fmt(total)}`);
		lines.push(`  LLM time:     ${fmt(llmTime)} (${pct(llmTime, total)})`);
		lines.push(`  Tool time:     ${fmt(toolTime)} (${pct(toolTime, total)})`);
		lines.push(`  Avg TTFB:     ${fmt(avgTtfb)}`);
		lines.push(`  Out throughput: ${outputTokPerSec} tok/s`);
		lines.push(`  Cache hit:     ${cacheHitRate}%`);
		lines.push(`  Input tokens:  ${fmtTokens(totalInput)}`);
		lines.push(`  Output tokens: ${fmtTokens(totalOutput)}`);
		if (totalCost > 0) lines.push(`  Cost:          $${totalCost.toFixed(4)}`);
		if (totalEnergy > 0)
			lines.push(
				`  Energy:        ${fmtEnergy({ energy_joules: totalEnergy, energy_kwh: totalEnergy / 3_600_000, duration_seconds: 0 })}`,
			);
		lines.push("");

		// ── Top tool output contributors ──
		if (t.tools.length > 0) {
			const toolOutputs = [...t.tools]
				.filter((tool) => tool.outputSize > 0)
				.sort((a, b) => b.outputSize - a.outputSize)
				.slice(0, 5);
			if (toolOutputs.length > 0) {
				lines.push("  ── Top Context Bloat Sources (tool output size) ────────");
				lines.push("");
				for (const tool of toolOutputs) {
					const argsStr = tool.argsSummary ? ` — ${tool.argsSummary}` : "";
					lines.push(`  ${fmtBytes(tool.outputSize).padStart(8)}  ${tool.name}${argsStr}`);
				}
				lines.push("");
			}
		}

		return lines.join("\n");
	}

	// ══════════════════════════════════════════════════════════════════
	// Commands
	// ══════════════════════════════════════════════════════════════════

	pi.registerCommand("timing", {
		description: "Show timing breakdown (use 'full', 'opt', 'reset', 'watch', or 'footer')",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();

			if (arg === "reset") {
				current = null;
				history = [];
				ctx.ui.notify("Timing data cleared", "info");
				return;
			}

			if (arg === "watch") {
				autoShow = !autoShow;
				ctx.ui.notify(`Auto timing: ${autoShow ? "ON" : "OFF"}`, "info");
				return;
			}

			if (arg === "footer") {
				footerEnabled = !footerEnabled;
				if (footerEnabled) {
					ctx.ui.setFooter((tui, theme, footerData) => {
						const unsub = footerData.onBranchChange(() => tui.requestRender());
						return {
							dispose: unsub,
							invalidate() {},
							render(width: number): string[] {
								if (!current) {
									footerEnabled = false;
									ctx.ui.setFooter(undefined);
									return [];
								}
								const elapsed = Date.now() - current.promptStart;
								const llmMs = current.requests.reduce((s, r) => s + (r.end || Date.now()) - r.start, 0);
								const toolMs = current.tools.reduce((s, r) => s + (r.end - r.start), 0);
								const totalIn = current.requests.reduce((s, r) => s + r.inputTokens, 0);
								const totalOut = current.requests.reduce((s, r) => s + r.outputTokens, 0);
								const outPerSec = llmMs > 0 ? Math.round(totalOut / (llmMs / 1000)) : 0;
								const cacheRate =
									totalIn > 0
										? Math.round(
												(current.requests.reduce((s, r) => s + r.cacheReadTokens, 0) / totalIn) * 100,
											)
										: 0;
								const totalEnergy = current.requests.reduce((s, r) => s + (r.energy?.energy_joules ?? 0), 0);

								const left = theme.fg("dim", `⏱ ${fmt(elapsed)}`);
								const parts: string[] = [];
								if (llmMs > 0) parts.push(`LLM ${fmt(llmMs)}`);
								if (toolMs > 0) parts.push(`tools ${fmt(toolMs)}`);
								if (outPerSec > 0) parts.push(`${outPerSec} tok/s`);
								if (cacheRate > 0) parts.push(`cache ${cacheRate}%`);
								const mid = parts.length > 0 ? theme.fg("dim", ` (${parts.join(", ")})`) : "";
								const energyStr =
									totalEnergy > 0
										? `⚡${fmtEnergy({ energy_joules: totalEnergy, energy_kwh: 0, duration_seconds: 0 })}`
										: "";
								const branch = footerData.getGitBranch();
								const right = theme.fg(
									"dim",
									`${energyStr}${ctx.model?.id || ""}${branch ? ` (${branch})` : ""}`,
								);
								const pad = " ".repeat(
									Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)),
								);
								return [truncateToWidth(left + mid + pad + right, width)];
							},
						};
					});
					ctx.ui.notify("Timing footer enabled", "info");
				} else {
					ctx.ui.setFooter(undefined);
					ctx.ui.notify("Timing footer disabled", "info");
				}
				return;
			}

			// Default: show summary, full, or opt
			const source = current || history[history.length - 1];
			if (!source) {
				ctx.ui.notify("No timing data yet. Run a prompt first.", "warning");
				return;
			}

			if (arg === "full") {
				ctx.ui.notify(formatFull(source), "info");
			} else if (arg === "opt") {
				ctx.ui.notify(formatOptimization(source), "info");
			} else {
				ctx.ui.notify(formatSummary(source), "info");
			}
		},
	});
}
