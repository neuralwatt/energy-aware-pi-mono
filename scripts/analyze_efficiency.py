#!/usr/bin/env python3
"""
Pi Session Efficiency Analyzer

Parses pi JSON-mode output and identifies specific tool calls and LLM requests
that are inefficient — too slow, too verbose, producing bloated output, or
wasting cache.

Usage:
  pi --mode json -p --no-session "your task" 2>/dev/null | python3 analyze_efficiency.py
  pi --mode json -p --no-session "your task" 2>/dev/null > session.jsonl
  python3 analyze_efficiency.py < session.jsonl
"""

import json
import sys
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class RequestInfo:
    turn_index: int
    start_ms: int
    end_ms: int
    model: str = ""
    response_model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost_total: float = 0.0
    energy_joules: float = 0.0
    energy_duration_s: float = 0.0
    stop_reason: str = ""
    diagnostics: list = field(default_factory=list)
    request_index: int = 0
    tool_calls_in_request: list = field(default_factory=list)

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass
class ToolCallInfo:
    turn_index: int
    call_id: str = ""
    name: str = ""
    args: dict = field(default_factory=dict)
    start_ms: int = 0  # timestamp of the assistant message_end that contains this toolCall
    end_ms: int = 0    # timestamp of the toolResult message_end
    output_chars: int = 0
    is_error: bool = False

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass
class TurnInfo:
    index: int
    start_ms: int = 0
    end_ms: int = 0
    requests: list = field(default_factory=list)
    tool_calls: list = field(default_factory=list)


@dataclass
class SessionAnalysis:
    session_id: str = ""
    start_ms: int = 0
    end_ms: int = 0
    turns: list = field(default_factory=list)
    requests: list = field(default_factory=list)
    tool_calls: list = field(default_factory=list)

    @property
    def total_ms(self) -> int:
        return self.end_ms - self.start_ms if self.end_ms and self.start_ms else 0

    @property
    def llm_ms(self) -> int:
        return sum(r.duration_ms for r in self.requests)

    @property
    def tool_ms(self) -> int:
        return sum(t.duration_ms for t in self.tool_calls)

    @property
    def overhead_ms(self) -> int:
        return max(0, self.total_ms - self.llm_ms - self.tool_ms)

    @property
    def total_input_tokens(self) -> int:
        return sum(r.input_tokens for r in self.requests)

    @property
    def total_output_tokens(self) -> int:
        return sum(r.output_tokens for r in self.requests)

    @property
    def total_cache_read(self) -> int:
        return sum(r.cache_read_tokens for r in self.requests)

    @property
    def total_cache_write(self) -> int:
        return sum(r.cache_write_tokens for r in self.requests)

    @property
    def total_cost(self) -> float:
        return sum(r.cost_total for r in self.requests)

    @property
    def total_energy_joules(self) -> float:
        return sum(r.energy_joules for r in self.requests)


def parse_session(lines) -> SessionAnalysis:
    s = SessionAnalysis()
    current_turn: Optional[TurnInfo] = None
    request_counter = 0
    # Track tool calls by their call ID, matching assistant toolCall → toolResult
    pending_tool_calls = {}  # call_id → ToolCallInfo
    # Track the last assistant message timestamp for tool start time inference
    last_assistant_end_ms = 0

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        t = obj.get("type", "")

        if t == "session":
            s.session_id = obj.get("id", "")
            ts_raw = obj.get("timestamp", 0)
            s.start_ms = _to_ms(ts_raw)

        elif t == "turn_start":
            ti = obj.get("turnIndex", len(s.turns))
            current_turn = TurnInfo(index=ti, start_ms=last_assistant_end_ms)
            s.turns.append(current_turn)

        elif t == "turn_end":
            pass  # timestamp on turn_end is the last event's timestamp

        elif t == "message_end":
            msg = obj.get("message", {})
            role = msg.get("role", "")
            ts = _to_ms(msg.get("timestamp", 0))

            if role == "assistant":
                request_counter += 1
                usage = msg.get("usage", {})
                cost = usage.get("cost", {})
                energy = msg.get("energy") or {}

                ri = RequestInfo(
                    turn_index=current_turn.index if current_turn else -1,
                    start_ms=last_assistant_end_ms if last_assistant_end_ms else s.start_ms,
                    end_ms=ts,
                    model=msg.get("model", ""),
                    response_model=msg.get("responseModel", ""),
                    input_tokens=usage.get("input", 0),
                    output_tokens=usage.get("output", 0),
                    cache_read_tokens=usage.get("cacheRead", 0),
                    cache_write_tokens=usage.get("cacheWrite", 0),
                    cost_total=cost.get("total", 0) if isinstance(cost, dict) else 0,
                    energy_joules=energy.get("energy_joules", 0),
                    energy_duration_s=energy.get("duration_seconds", 0),
                    stop_reason=msg.get("stopReason", ""),
                    diagnostics=msg.get("diagnostics", []),
                    request_index=request_counter,
                )
                s.requests.append(ri)
                if current_turn:
                    current_turn.requests.append(ri)

                # Extract tool calls embedded in this assistant message
                for content in msg.get("content", []):
                    if content.get("type") == "toolCall":
                        tcid = content.get("id", "")
                        tc = ToolCallInfo(
                            turn_index=current_turn.index if current_turn else -1,
                            call_id=tcid,
                            name=content.get("name", ""),
                            args=content.get("arguments", {}),
                            start_ms=ts,  # tool starts when assistant finishes
                            end_ms=ts,
                        )
                        pending_tool_calls[tcid] = tc
                        s.tool_calls.append(tc)
                        if current_turn:
                            current_turn.tool_calls.append(tc)
                        ri.tool_calls_in_request.append(tcid)

                last_assistant_end_ms = ts

                if current_turn:
                    current_turn.end_ms = ts

            elif role == "toolResult":
                tcid = msg.get("toolCallId", "")
                content_list = msg.get("content", [])
                size = sum(len(c.get("text", "")) for c in content_list if c.get("type") == "text")

                if tcid in pending_tool_calls:
                    pending_tool_calls[tcid].end_ms = ts
                    pending_tool_calls[tcid].output_chars = size
                    pending_tool_calls[tcid].is_error = msg.get("isError", False)
                    pending_tool_calls[tcid].turn_index = current_turn.index if current_turn else -1

                # Update last assistant end for next request timing
                last_assistant_end_ms = ts

            elif role == "user":
                if s.start_ms == 0 and ts:
                    s.start_ms = ts
                last_assistant_end_ms = ts

        elif t == "agent_end":
            # Use the last event timestamp
            if s.requests:
                s.end_ms = s.requests[-1].end_ms
            else:
                s.end_ms = s.start_ms

    # Compute overall end from last request
    if not s.end_ms and s.requests:
        s.end_ms = s.requests[-1].end_ms

    # Compute turn starts from their first request
    for turn in s.turns:
        if turn.requests:
            turn.start_ms = turn.start_ms or turn.requests[0].start_ms
            turn.end_ms = turn.end_ms or turn.requests[-1].end_ms

    return s


def _to_ms(ts) -> int:
    """Convert timestamp to milliseconds. Handles int (Unix ms), float, or ISO string."""
    if isinstance(ts, (int, float)):
        return int(ts)
    if isinstance(ts, str):
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000)
        except (ValueError, OSError):
            return 0
    return 0


def fmt_ms(ms: int) -> str:
    if ms < 1000:
        return f"{ms}ms"
    if ms < 60_000:
        return f"{ms / 1000:.1f}s"
    mins = ms // 60_000
    secs = (ms % 60_000) / 1000
    return f"{mins}m{secs:.0f}s"


def fmt_tokens(n: int) -> str:
    if n < 1000:
        return f"{n}"
    if n < 1_000_000:
        return f"{n / 1000:.1f}k"
    return f"{n / 1_000_000:.2f}M"


def fmt_bytes(b: int) -> str:
    if b < 1024:
        return f"{b}B"
    if b < 1024 * 1024:
        return f"{b / 1024:.1f}KB"
    return f"{b / (1024 * 1024):.1f}MB"


def fmt_joules(j: float) -> str:
    if j < 1:
        return f"{j * 1000:.0f}mJ"
    if j < 1000:
        return f"{j:.1f}J"
    return f"{j / 1000:.2f}kJ"


def analyze(s: SessionAnalysis) -> str:
    lines: list[str] = []
    total = s.total_ms
    llm = s.llm_ms
    tools = s.tool_ms
    overhead = s.overhead_ms

    # Header
    lines.append("")
    lines.append("=" * 72)
    lines.append("  EFFICIENCY ANALYSIS REPORT")
    lines.append("=" * 72)
    lines.append("")

    # ── Overall ──
    lines.append("── Overall ────────────────────────────────────────────────────")
    lines.append("")
    lines.append(f"  Wall clock:     {fmt_ms(total)}")
    lines.append(f"  LLM time:       {fmt_ms(llm)} ({100 * llm // total if total else 0}%)")
    lines.append(f"  Tool time:      {fmt_ms(tools)} ({100 * tools // total if total else 0}%)")
    lines.append(f"  Overhead:       {fmt_ms(overhead)} ({100 * overhead // total if total else 0}%)")
    lines.append(f"  Turns:          {len(s.turns)}")
    lines.append(f"  Tool calls:     {len(s.tool_calls)}")
    lines.append(f"  Input tokens:   {fmt_tokens(s.total_input_tokens)} (across all requests)")
    lines.append(f"  Output tokens:  {fmt_tokens(s.total_output_tokens)}")
    out_per_sec = s.total_output_tokens / (llm / 1000) if llm > 0 else 0
    lines.append(f"  Out throughput: {out_per_sec:.0f} tok/s")
    total_context_tokens = s.total_input_tokens + s.total_cache_read
    cache_hit = (s.total_cache_read / total_context_tokens * 100) if total_context_tokens > 0 else 0
    lines.append(f"  Cache hit rate: {cache_hit:.0f}%")
    lines.append(f"  Cache read:     {fmt_tokens(s.total_cache_read)}")
    lines.append(f"  Cache write:    {fmt_tokens(s.total_cache_write)}")
    lines.append(f"  Cost:           ${s.total_cost:.4f}")
    if s.total_energy_joules > 0:
        lines.append(f"  Energy:         {fmt_joules(s.total_energy_joules)}")
    lines.append("")

    # ── Per-request breakdown ──
    lines.append("── LLM Requests (ranked by inefficiency) ──────────────────────")
    lines.append("")

    req_scores = []
    for i, r in enumerate(s.requests):
        issues = []
        dur_ms = r.duration_ms
        score = 0

        # High context with low cache
        total_ctx = r.input_tokens + r.cache_read_tokens
        cache_pct = (r.cache_read_tokens / total_ctx * 100) if total_ctx > 0 else 0
        # Only warn on cache for requests with substantial context
        if total_ctx > 5_000:
            if cache_pct < 30:
                issues.append(f"LOW CACHE ({cache_pct:.0f}% of {fmt_tokens(total_ctx)} context from cache, {fmt_tokens(r.input_tokens)} new tokens)")
                score += 30
            elif cache_pct < 60:
                issues.append(f"moderate cache ({cache_pct:.0f}% of {fmt_tokens(total_ctx)} context from cache)")
                score += 10
        elif r.input_tokens > 50_000:
            issues.append(f"HUGE CONTEXT ({fmt_tokens(r.input_tokens)} new input tokens)")
            score += 25
        elif r.input_tokens > 10_000 and r.cache_read_tokens == 0:
            issues.append(f"NO CACHE on {fmt_tokens(r.input_tokens)} input — all tokens billed at full price")
            score += 20

        # Low output throughput
        if dur_ms > 0:
            tps = r.output_tokens / (dur_ms / 1000)
            if tps < 15 and r.output_tokens > 100:
                issues.append(f"slow generation ({tps:.0f} tok/s)")
                score += 20
            elif tps < 30 and r.output_tokens > 500:
                issues.append(f"moderate generation ({tps:.0f} tok/s)")
                score += 10

        # High GPU energy per token
        if r.energy_joules > 0 and r.output_tokens > 0:
            jpt = r.energy_joules / r.output_tokens
            if jpt > 2.0:
                issues.append(f"high energy/token ({jpt:.2f} J/tok)")
                score += 15

        # Diagnostics / errors
        if r.diagnostics:
            issues.append(f"{len(r.diagnostics)} diagnostics")
            score += 10

        # Excessive output tokens
        if r.output_tokens > 2000:
            issues.append(f"verbose output ({fmt_tokens(r.output_tokens)})")
            score += 5

        # Stop reason
        if r.stop_reason == "length":
            issues.append("HIT LENGTH LIMIT — truncated output")
            score += 25

        # Input token spike (this request's input >> previous request's input)
        if i > 0:
            prev_input = s.requests[i - 1].input_tokens
            if r.input_tokens > prev_input * 2 and prev_input > 0:
                delta = r.input_tokens - prev_input
                issues.append(f"INPUT SPIKE +{fmt_tokens(delta)} tokens from prev request (tool output bloat?)")
                score += 15

        req_scores.append((score, i, issues))

    req_scores.sort(key=lambda x: -x[0])

    for score, i, issues in req_scores:
        r = s.requests[i]
        dur_ms = r.duration_ms
        tps = r.output_tokens / (dur_ms / 1000) if dur_ms > 0 else 0
        cache_pct = (r.cache_read_tokens / (r.input_tokens + r.cache_read_tokens) * 100) if (r.input_tokens + r.cache_read_tokens) > 0 else 0

        if score == 0:
            marker = "✓"
        elif score < 15:
            marker = "·"
        elif score < 30:
            marker = "⚠"
        else:
            marker = "🔥"

        lines.append(f"  {marker} Request {i + 1} (turn {r.turn_index + 1}): {fmt_ms(dur_ms)} | "
                      f"{fmt_tokens(r.input_tokens)} in | {fmt_tokens(r.output_tokens)} out | "
                      f"{tps:.0f} tok/s | cache {cache_pct:.0f}% | ${r.cost_total:.4f}")
        if r.response_model and r.response_model != r.model:
            lines.append(f"    Routed: {r.model} → {r.response_model}")
        if r.energy_joules > 0:
            lines.append(f"    Energy: {fmt_joules(r.energy_joules)} ({r.energy_duration_s:.1f}s GPU)")
        # Show tool calls spawned
        if r.tool_calls_in_request:
            tc_names = []
            for tcid in r.tool_calls_in_request:
                tc = next((t for t in s.tool_calls if t.call_id == tcid), None)
                if tc:
                    tc_names.append(tc.name)
            if tc_names:
                lines.append(f"    Tool calls: {', '.join(tc_names)}")
        for issue in issues:
            lines.append(f"    → {issue}")
        lines.append("")

    # ── Tool calls ranked by inefficiency ──
    lines.append("── Tool Calls (ranked by inefficiency) ────────────────────────")
    lines.append("")

    tool_scores = []
    for i, tc in enumerate(s.tool_calls):
        dur_ms = tc.duration_ms
        issues = []
        score = 0

        # Bloated output — #1 context bloat source
        if tc.output_chars > 20_000:
            issues.append(f"HUGE OUTPUT ({fmt_bytes(tc.output_chars)}) — inflates next LLM request")
            score += 30
        elif tc.output_chars > 5_000:
            issues.append(f"large output ({tc.output_chars:,} chars)")
            score += 15
        elif tc.output_chars > 2_000:
            issues.append(f"moderate output ({tc.output_chars:,} chars)")
            score += 5

        # Slow execution
        if dur_ms > 5000:
            issues.append(f"slow ({fmt_ms(dur_ms)})")
            score += 15
        elif dur_ms > 2000:
            issues.append(f"moderate ({fmt_ms(dur_ms)})")
            score += 5

        # Read without offset/limit
        if tc.name == "read" and tc.args:
            has_offset = tc.args.get("offset") is not None
            has_limit = tc.args.get("limit") is not None
            if not has_offset and not has_limit and tc.output_chars > 3000:
                issues.append("full-file read (no offset/limit) — likely read more than needed")
                score += 10

        # Bash that could be more targeted
        if tc.name == "bash" and tc.args:
            cmd = str(tc.args.get("command", ""))
            if "cat " in cmd and tc.output_chars > 2000:
                issues.append("'cat' in bash — consider 'head' or 'grep' to limit output")
                score += 8
            # Long-running command
            if dur_ms > 3000:
                issues.append(f"long-running command: {cmd[:60]}")

        # Write with huge content
        if tc.name == "write" and tc.args:
            content = str(tc.args.get("content", ""))
            lines_count = content.count("\n") + 1
            if lines_count > 100:
                issues.append(f"large write ({lines_count} lines) — could use edit for targeted changes")
                score += 5

        # Edit with many replacements
        if tc.name == "edit" and tc.args:
            edits = tc.args.get("edits", [])
            if isinstance(edits, list) and len(edits) > 3:
                issues.append(f"many edits ({len(edits)}) — consider whether all are needed in one call")

        tool_scores.append((score, i, issues))

    tool_scores.sort(key=lambda x: -x[0])

    for score, i, issues in tool_scores:
        tc = s.tool_calls[i]

        if score == 0:
            marker = "✓"
        elif score < 15:
            marker = "·"
        elif score < 30:
            marker = "⚠"
        else:
            marker = "🔥"

        # Build arg summary
        arg_summary = ""
        if tc.name == "bash":
            cmd = str(tc.args.get("command", ""))[:70]
            arg_summary = f"$ {cmd}"
        elif tc.name == "read":
            p = tc.args.get("file_path") or tc.args.get("path") or ""
            offset = tc.args.get("offset")
            limit = tc.args.get("limit")
            arg_summary = p
            if offset or limit:
                arg_summary += f" (offset={offset}, limit={limit})"
        elif tc.name == "write":
            p = tc.args.get("file_path") or tc.args.get("path") or ""
            arg_summary = p
        elif tc.name == "edit":
            p = tc.args.get("file_path") or tc.args.get("path") or ""
            arg_summary = p

        out_str = f" | {tc.output_chars:,} chars" if tc.output_chars > 500 else ""
        lines.append(f"  {marker} {tc.name} ({fmt_ms(tc.duration_ms)}{out_str}) [turn {tc.turn_index + 1}]")
        if arg_summary:
            lines.append(f"    {arg_summary}")
        for issue in issues:
            lines.append(f"    → {issue}")
        lines.append("")

    # ── Context bloat analysis ──
    lines.append("── Context Bloat Analysis ─────────────────────────────────────")
    lines.append("")

    total_tool_output = sum(tc.output_chars for tc in s.tool_calls)
    lines.append(f"  Total tool output:       {fmt_bytes(total_tool_output)}")

    # Per-tool breakdown
    tool_types: dict[str, dict] = {}
    for tc in s.tool_calls:
        if tc.name not in tool_types:
            tool_types[tc.name] = {"count": 0, "total_output": 0, "total_ms": 0, "max_output": 0}
        tool_types[tc.name]["count"] += 1
        tool_types[tc.name]["total_output"] += tc.output_chars
        tool_types[tc.name]["total_ms"] += tc.duration_ms
        tool_types[tc.name]["max_output"] = max(tool_types[tc.name]["max_output"], tc.output_chars)

    lines.append("")
    lines.append(f"  {'Tool':<10} {'Calls':>5} {'Total out':>10} {'Max out':>10} {'Time':>10}")
    lines.append(f"  {'─' * 10} {'─' * 5} {'─' * 10} {'─' * 10} {'─' * 10}")
    for name, info in sorted(tool_types.items(), key=lambda x: -x[1]["total_output"]):
        lines.append(
            f"  {name:<10} {info['count']:>5} {fmt_bytes(info['total_output']):>10} {fmt_bytes(info['max_output']):>10} {fmt_ms(info['total_ms']):>10}"
        )

    # Tool output as % of input tokens
    lines.append("")
    if s.requests and total_tool_output > 0:
        tool_output_tokens_est = total_tool_output / 4
        pct_of_input = (tool_output_tokens_est / s.total_input_tokens * 100) if s.total_input_tokens > 0 else 0
        lines.append(f"  Tool output as % of total input: ~{pct_of_input:.0f}%")
        lines.append(f"  (estimated: {fmt_tokens(int(tool_output_tokens_est))} of {fmt_tokens(s.total_input_tokens)} input tokens)")
    lines.append("")

    # ── Per-turn context growth ──
    lines.append("── Per-Turn Context Growth ─────────────────────────────────────")
    lines.append("")

    cumulative_tool_output = 0
    for turn in s.turns:
        turn_tool_output = sum(tc.output_chars for tc in turn.tool_calls)
        cumulative_tool_output += turn_tool_output

        turn_input = sum(r.input_tokens for r in turn.requests)
        turn_output_tokens = sum(r.output_tokens for r in turn.requests)
        turn_cache = sum(r.cache_read_tokens for r in turn.requests)
        turn_total_ctx = turn_input + turn_cache
        turn_cache_pct = (turn_cache / turn_total_ctx * 100) if turn_total_ctx > 0 else 0
        turn_energy = sum(r.energy_joules for r in turn.requests)
        turn_cost = sum(r.cost_total for r in turn.requests)
        turn_dur = sum(r.duration_ms for r in turn.requests)

        tool_names = [tc.name for tc in turn.tool_calls]
        tools_str = ", ".join(tool_names) if tool_names else "none"

        lines.append(
            f"  Turn {turn.index + 1}: "
            f"{fmt_ms(turn_dur)} LLM │ "
            f"{fmt_tokens(turn_input)} in │ "
            f"{fmt_tokens(turn_output_tokens)} out │ "
            f"cache {turn_cache_pct:.0f}% │ "
            f"tool out {fmt_bytes(turn_tool_output)} │ "
            f"cumul {fmt_bytes(cumulative_tool_output)} │ "
            f"${turn_cost:.4f}"
        )
        lines.append(
            f"           "
            f"tools: [{tools_str}]"
        )

        # Show input token spike
        if turn.index > 0:
            prev_turn = s.turns[turn.index - 1] if turn.index - 1 < len(s.turns) else None
            if prev_turn:
                prev_input = sum(r.input_tokens for r in prev_turn.requests)
                if turn_input > prev_input * 1.5 and prev_input > 0:
                    delta = turn_input - prev_input
                    lines.append(
                        f"           ⚠ INPUT SPIKE +{fmt_tokens(delta)} from prev turn"
                    )
    lines.append("")

    # ── Actionable recommendations ──
    lines.append("── Actionable Recommendations ──────────────────────────────────")
    lines.append("")

    recs = []

    big_outputs = [tc for tc in s.tool_calls if tc.output_chars > 10_000]
    if big_outputs:
        examples = [(tc.name, tc.output_chars) for tc in sorted(big_outputs, key=lambda x: -x.output_chars)[:3]]
        ex_str = ", ".join(f"{n} ({fmt_bytes(s)})" for n, s in examples)
        recs.append(("CRITICAL", f"Reduce tool output size: {ex_str}. These outputs get fed back as input tokens on every subsequent LLM call, compounding cost and latency.", "Add truncation, use head/grep for bash, offset/limit for reads."))

    if cache_hit < 60 and total_context_tokens > 5000:
        recs.append(("HIGH", f"Improve cache hit rate ({cache_hit:.0f}%). Low cache means paying full input price each turn.", "Ensure stable system prompt prefix. Minimize context mutations between turns. Compact earlier."))

    full_reads = [tc for tc in s.tool_calls if tc.name == "read" and tc.args.get("offset") is None and tc.output_chars > 3000]
    if full_reads:
        recs.append(("MEDIUM", f"{len(full_reads)} full-file read(s) without offset/limit produced large output.", "Use offset/limit to read only needed sections, or grep first to find relevant lines."))

    cat_bash = [tc for tc in s.tool_calls if tc.name == "bash" and "cat " in str(tc.args.get("command", ""))]
    if cat_bash:
        recs.append(("MEDIUM", f"{len(cat_bash)} bash call(s) use 'cat'.", "Replace with 'head -N', 'grep', or the read tool with offset/limit."))

    if len(s.turns) > 4:
        recs.append(("MEDIUM", f"{len(s.turns)} turns. Each turn re-sends the full context.", "Encourage the model to batch tool calls or be more targeted to reduce round-trips."))

    if out_per_sec < 20 and s.total_output_tokens > 500:
        recs.append(("HIGH", f"Output throughput is {out_per_sec:.0f} tok/s.", "This may indicate a loaded GPU or oversized model. Consider a smaller/faster model for routine tasks."))

    if s.total_energy_joules > 0 and s.total_output_tokens > 0:
        jpt = s.total_energy_joules / s.total_output_tokens
        if jpt > 1.5:
            recs.append(("MEDIUM", f"Energy efficiency: {jpt:.2f} J/output token. Above baseline.", "Check neuralwatt_agent Q-learning policy is active and GPU power state is optimized."))

    # Check for input token growth between turns
    inputs = [sum(r.input_tokens for r in turn.requests) for turn in s.turns]
    if len(inputs) >= 2 and inputs[-1] > inputs[0] * 3:
        growth = inputs[-1] - inputs[0]
        recs.append(("HIGH", f"Context grew by {fmt_tokens(growth)} over {len(s.turns)} turns ({fmt_tokens(inputs[0])} → {fmt_tokens(inputs[-1])}).", "Tool output is likely accumulating in context. Add truncation or compact earlier."))

    if not recs:
        recs.append(("INFO", "No major inefficiencies detected.", ""))

    for severity, problem, solution in recs:
        icon = {"CRITICAL": "🔥", "HIGH": "⚠️", "MEDIUM": "💡", "INFO": "✅"}.get(severity, "·")
        lines.append(f"  {icon} [{severity}]")
        lines.append(f"     Problem: {problem}")
        if solution:
            lines.append(f"     Fix:     {solution}")
        lines.append("")

    return "\n".join(lines)


def main():
    lines = sys.stdin.readlines()
    s = parse_session(lines)
    print(analyze(s))


if __name__ == "__main__":
    main()
