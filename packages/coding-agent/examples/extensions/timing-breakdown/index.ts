/**
 * Timing Breakdown Extension
 *
 * Tracks wall-clock time spent in LLM requests vs tool calls vs overhead,
 * with per-tool and per-turn breakdowns.
 *
 * Commands:
 *   /timing        — Show timing summary for the last prompt
 *   /timing full   — Show detailed per-turn and per-tool breakdown
 *   /timing reset  — Clear accumulated timing data
 *   /timing watch  — Toggle auto-display after each agent_end
 *
 * Also shows a compact timing line in the footer that updates live.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Types ──────────────────────────────────────────────────────────

interface RequestTiming {
	start: number; // Date.now() at before_provider_request
	ttfb?: number; // ms to first byte (after_provider_response)
	end: number; // Date.now() when assistant message_end fires
	turnIndex: number;
}

interface ToolTiming {
	toolCallId: string;
	name: string;
	start: number; // Date.now() at tool_execution_start
	end: number; // Date.now() at tool_execution_end
	isError: boolean;
	turnIndex: number;
}

interface TurnTiming {
	index: number;
	start: number; // turn_start timestamp
	end: number; // turn_end timestamp
	requestStart?: number;
	requestTtfb?: number;
	requestEnd?: number;
	tools: ToolTiming[];
}

interface PromptTiming {
	promptStart: number; // agent_start
	promptEnd: number; // agent_end
	turns: TurnTiming[];
	requests: RequestTiming[];
	tools: ToolTiming[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function fmt(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60_000);
	const secs = Math.round((ms % 60_000) / 1000);
	return `${mins}m${secs}s`;
}

function pct(part: number, whole: number): string {
	if (whole === 0) return "0%";
	return `${Math.round((part / whole) * 100)}%`;
}

function bar(part: number, whole: number, width = 20): string {
	if (whole === 0) return " ".repeat(width);
	const filled = Math.round((part / whole) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let current: PromptTiming | null = null;
	let history: PromptTiming[] = [];
	let autoShow = false;
	let footerEnabled = false;

	// ── Accumulator for in-flight request tracking ──

	// We track pending requests by turn to handle multi-turn flows
	const pendingRequests = new Map<number, number>(); // turnIndex -> request start time
	let currentTurnIndex = 0;

	// ── Agent lifecycle ──

	pi.on("agent_start", async () => {
		current = {
			promptStart: Date.now(),
			promptEnd: 0,
			turns: [],
			requests: [],
			tools: [],
		};
		currentTurnIndex = 0;
		pendingRequests.clear();
		if (footerEnabled) {
			pi.sendUserMessage("/timing footer-on", { deliverAs: "followUp" });
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!current) return;
		current.promptEnd = Date.now();
		history.push(current);

		// Keep only last 20 prompts
		if (history.length > 20) history = history.slice(-20);

		if (autoShow) {
			const summary = formatSummary(current);
			ctx.ui.notify(summary, "info");
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
		});
	});

	pi.on("turn_end", async (_event) => {
		if (!current) return;
		const turn = current.turns.find((t) => t.index === currentTurnIndex);
		if (turn) turn.end = Date.now();
	});

	// ── Provider request tracking ──

	pi.on("before_provider_request", async () => {
		if (!current) return;
		const start = Date.now();
		pendingRequests.set(currentTurnIndex, start);
		current.requests.push({
			start,
			end: 0,
			turnIndex: currentTurnIndex,
		});
	});

	pi.on("after_provider_response", async () => {
		if (!current) return;
		const now = Date.now();
		const req = [...current.requests].reverse().find((r) => r.end === 0);
		if (req) {
			req.ttfb = now - req.start;
		}
		// Update turn's request timing
		const turn = current.turns.find((t) => t.index === req?.turnIndex);
		if (turn && req) {
			turn.requestStart = req.start;
			turn.requestTtfb = req.ttfb;
		}
	});

	pi.on("message_end", async (event) => {
		if (!current) return;
		if (event.message.role !== "assistant") return;
		const now = Date.now();
		// Close the most recent open request
		const req = [...current.requests].reverse().find((r) => r.end === 0);
		if (req) {
			req.end = now;
		}
		// Update turn's request end
		const turn = current.turns.find((t) => t.index === req?.turnIndex);
		if (turn && req) {
			turn.requestEnd = now;
		}
	});

	// ── Tool execution tracking ──

	pi.on("tool_execution_start", async (event) => {
		if (!current) return;
		current.tools.push({
			toolCallId: event.toolCallId,
			name: event.toolName,
			start: Date.now(),
			end: 0,
			isError: false,
			turnIndex: currentTurnIndex,
		});
		// Also push to the current turn
		const turn = current.turns.find((t) => t.index === currentTurnIndex);
		if (turn) {
			turn.tools.push(current.tools[current.tools.length - 1]);
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (!current) return;
		const t = current.tools.find((t) => t.toolCallId === event.toolCallId && t.end === 0);
		if (t) {
			t.end = Date.now();
			t.isError = event.isError;
		}
	});

	// ── Formatting ──

	function formatSummary(t: PromptTiming): string {
		const total = t.promptEnd - t.promptStart;
		if (total === 0) return "No timing data";

		const llmTime = t.requests.reduce((s, r) => s + (r.end - r.start), 0);
		const toolTime = t.tools.reduce((s, r) => s + (r.end - r.start), 0);
		const overhead = total - llmTime - toolTime;
		const turns = t.turns.length;
		const toolCalls = t.tools.length;

		const lines: string[] = [];
		lines.push(
			`⏱  ${fmt(total)} total │ ${fmt(llmTime)} LLM (${pct(llmTime, total)}) │ ${fmt(toolTime)} tools (${pct(toolTime, total)}) │ ${fmt(overhead)} overhead (${pct(overhead, total)})`,
		);
		lines.push(`   ${turns} turn${turns !== 1 ? "s" : ""} │ ${toolCalls} tool call${toolCalls !== 1 ? "s" : ""}`);

		if (t.requests.length > 0) {
			const avgTtfb = t.requests.reduce((s, r) => s + (r.ttfb ?? 0), 0) / t.requests.length;
			lines.push(`   TTFB: ${fmt(avgTtfb)} avg`);
		}

		return lines.join("\n");
	}

	function formatFull(t: PromptTiming): string {
		const total = t.promptEnd - t.promptStart;
		if (total === 0) return "No timing data";

		const llmTime = t.requests.reduce((s, r) => s + (r.end - r.start), 0);
		const toolTime = t.tools.reduce((s, r) => s + (r.end - r.start), 0);
		const overhead = total - llmTime - toolTime;

		const lines: string[] = [];

		// ── Header: overall breakdown ──
		lines.push("");
		lines.push("╭─────────────────────────────────────────────────────────╮");
		lines.push("│  TIMING BREAKDOWN                                       │");
		lines.push("╰─────────────────────────────────────────────────────────╯");
		lines.push("");
		lines.push(`  Total: ${fmt(total)}`);
		lines.push("");
		lines.push(`  LLM requests  ${bar(llmTime, total)} ${fmt(llmTime)} (${pct(llmTime, total)})`);
		lines.push(`  Tool calls     ${bar(toolTime, total)} ${fmt(toolTime)} (${pct(toolTime, total)})`);
		lines.push(
			`  Overhead       ${bar(Math.max(0, overhead), total)} ${fmt(Math.max(0, overhead))} (${pct(Math.max(0, overhead), total)})`,
		);
		lines.push("");

		// ── Per-turn breakdown ──
		if (t.turns.length > 0) {
			lines.push("  ── Per Turn ──────────────────────────────────────────");
			lines.push("");
			for (const turn of t.turns) {
				const turnTotal = (turn.end || t.promptEnd) - turn.start;
				const turnLlm =
					turn.requestStart != null && turn.requestEnd != null ? turn.requestEnd - turn.requestStart : 0;
				const turnTool = turn.tools.reduce((s, t) => s + (t.end - t.start), 0);
				const turnOverhead = turnTotal - turnLlm - turnTool;

				lines.push(`  Turn ${turn.index + 1}: ${fmt(turnTotal)}`);
				lines.push(`    LLM: ${fmt(turnLlm)}${turn.requestTtfb ? ` (TTFB: ${fmt(turn.requestTtfb)})` : ""}`);
				lines.push(`    Tools: ${fmt(turnTool)} (${turn.tools.length} call${turn.tools.length !== 1 ? "s" : ""})`);
				if (turnOverhead > 100) {
					lines.push(`    Overhead: ${fmt(turnOverhead)}`);
				}

				// Per-tool detail for this turn
				if (turn.tools.length > 0) {
					const toolGroups = new Map<string, { count: number; time: number; errors: number }>();
					for (const tool of turn.tools) {
						const g = toolGroups.get(tool.name) || { count: 0, time: 0, errors: 0 };
						g.count++;
						g.time += tool.end - tool.start;
						if (tool.isError) g.errors++;
						toolGroups.set(tool.name, g);
					}
					const parts = Array.from(toolGroups.entries())
						.sort((a, b) => b[1].time - a[1].time)
						.map(([name, g]) => `${name}×${g.count}: ${fmt(g.time)}${g.errors > 0 ? ` (${g.errors} err)` : ""}`);
					lines.push(`    [${parts.join(", ")}]`);
				}
				lines.push("");
			}
		}

		// ── All-time tool summary ──
		if (t.tools.length > 0) {
			lines.push("  ── All Tool Calls ──────────────────────────────────");
			lines.push("");
			const toolGroups = new Map<
				string,
				{ count: number; totalTime: number; min: number; max: number; errors: number }
			>();
			for (const tool of t.tools) {
				const elapsed = tool.end - tool.start;
				const g = toolGroups.get(tool.name) || { count: 0, totalTime: 0, min: Infinity, max: 0, errors: 0 };
				g.count++;
				g.totalTime += elapsed;
				g.min = Math.min(g.min, elapsed);
				g.max = Math.max(g.max, elapsed);
				if (tool.isError) g.errors++;
				toolGroups.set(tool.name, g);
			}

			const maxName = Math.max(...Array.from(toolGroups.keys()).map((n) => n.length), 4);
			for (const [name, g] of toolGroups) {
				const avg = g.totalTime / g.count;
				const errStr = g.errors > 0 ? `  (${g.errors} err)` : "";
				const barW = 12;
				lines.push(
					`  ${name.padEnd(maxName)}  ${bar(g.totalTime, total, barW)}  total ${fmt(g.totalTime)}  avg ${fmt(avg)}  min ${fmt(g.min)}  max ${fmt(g.max)}  ×${g.count}${errStr}`,
				);
			}
			lines.push("");
		}

		// ── Request latency ──
		if (t.requests.length > 0) {
			lines.push("  ── LLM Requests ───────────────────────────────────");
			lines.push("");
			for (let i = 0; i < t.requests.length; i++) {
				const r = t.requests[i];
				const dur = r.end - r.start;
				const ttfbStr = r.ttfb != null ? `  TTFB: ${fmt(r.ttfb)}` : "";
				lines.push(`  Request ${i + 1} (turn ${r.turnIndex + 1}): ${fmt(dur)}${ttfbStr}`);
			}
			const avgTtfb = t.requests.reduce((s, r) => s + (r.ttfb ?? 0), 0) / t.requests.length;
			const avgDur = t.requests.reduce((s, r) => s + (r.end - r.start), 0) / t.requests.length;
			lines.push("");
			lines.push(`  Avg request: ${fmt(avgDur)}  Avg TTFB: ${fmt(avgTtfb)}`);
			lines.push("");
		}

		return lines.join("\n");
	}

	// ── Commands ──

	pi.registerCommand("timing", {
		description: "Show timing breakdown (use 'full', 'reset', or 'watch')",
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

			if (arg === "footer" || arg === "footer-on") {
				footerEnabled = true;
				ctx.ui.setFooter((tui, theme, footerData) => {
					const unsub = footerData.onBranchChange(() => tui.requestRender());
					return {
						dispose: unsub,
						invalidate() {},
						render(width: number): string[] {
							if (!current || !footerEnabled) {
								footerEnabled = false;
								ctx.ui.setFooter(undefined);
								return [];
							}
							const elapsed = Date.now() - current.promptStart;
							const llmMs = current.requests.reduce((s, r) => s + (r.end || Date.now()) - r.start, 0);
							const toolMs = current.tools.reduce((s, r) => s + (r.end - r.start), 0);

							const left = theme.fg("dim", `⏱ ${fmt(elapsed)}`);
							const parts: string[] = [];
							if (llmMs > 0) parts.push(`LLM ${fmt(llmMs)}`);
							if (toolMs > 0) parts.push(`tools ${fmt(toolMs)}`);
							const mid = parts.length > 0 ? theme.fg("dim", ` (${parts.join(", ")})`) : "";
							const branch = footerData.getGitBranch();
							const right = theme.fg("dim", `${ctx.model?.id || ""}${branch ? ` (${branch})` : ""}`);
							const pad = " ".repeat(
								Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)),
							);
							return [truncateToWidth(left + mid + pad + right, width)];
						},
					};
				});
				ctx.ui.notify("Timing footer enabled", "info");
				return;
			}

			if (arg === "footer-off") {
				footerEnabled = false;
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Timing footer disabled", "info");
				return;
			}

			// Default: show summary or full
			const source = current || history[history.length - 1];
			if (!source) {
				ctx.ui.notify("No timing data yet. Run a prompt first.", "warning");
				return;
			}

			if (arg === "full") {
				// Use notify for the full breakdown since it can be long
				ctx.ui.notify(formatFull(source), "info");
			} else {
				ctx.ui.notify(formatSummary(source), "info");
			}
		},
	});
}
