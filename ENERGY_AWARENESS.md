# Energy-Aware Mode

This document is the implementation reference for energy-aware operation in
pi-mono, using Neuralwatt endpoints.

## Table of Contents

- [Overview](#overview)
- [Quickstart](#quickstart)
- [Architecture](#architecture)
- [Type System](#type-system)
- [Provider Integration](#provider-integration)
- [Policy Framework](#policy-framework)
- [Agent Loop Integration](#agent-loop-integration)
- [SDK Integration](#sdk-integration)
- [Benchmark Harness](#benchmark-harness)
- [Live Demos](#live-demos)
- [Testing](#testing)
- [Acceptance Criteria](#acceptance-criteria)
- [Downstream Integration (openclaw)](#downstream-integration-openclaw)

---

## Overview

pi-mono supports two runtime modes that can be compared head-to-head:

- **Baseline Mode** — default behavior, no policy intervention, all model
  calls use full parameters
- **Energy-Aware Mode** — a runtime policy observes energy consumption per
  call and adaptively reduces it without degrading task success rate

Both modes use the **same Neuralwatt endpoint** (`https://api.neuralwatt.com/v1`).
The only difference is the active `RuntimePolicy`.

When no policy is configured, the agent loop behaves identically to upstream
pi-mono — all energy features are opt-in.

---

## Quickstart

### What It Does

Energy-aware mode gives AI agents a **energy budget** and a policy that
automatically adapts behavior to stay within it. Instead of every model call
using maximum parameters regardless of cost, the agent learns to spend energy
where it matters and conserve where it doesn't.

**Capabilities at a glance:**

- **Per-request energy telemetry** — every LLM call reports joules consumed,
  kWh, and server-side duration, attached directly to the response message
- **Pluggable runtime policies** — swap between baseline (no intervention)
  and energy-aware (adaptive 5-strategy chain) with a single config change
- **Adaptive strategy chain** — as budget pressure rises, the policy
  progressively reduces reasoning depth, caps output tokens, routes to
  cheaper models, compacts context, and ultimately aborts if the budget is
  exhausted. Can leverage budget as informational only via config.
- **Model routing** — automatically switches to the most cost-effective model
  that still meets capability requirements (reasoning, image support) while 
  aggressively upgrading model capability on subtask failure to ensure problem
  convergence while maintaining efficiency.
- **Structured telemetry** — JSONL telemetry records for every call, ready
  for dashboards, auditing, or billing
- **Benchmark harness** — compare baseline vs energy-aware mode side-by-side
  with automated scoring and reporting

### Potential Impact

| Metric | Target | How |
|--------|--------|-----|
| Energy per task | **>=80% reduction** vs baseline | Reasoning reduction, token capping, model routing |
| Success rate | **<=5% degradation** vs baseline | Strategies are progressive — light interventions first |
| Cost per task | Proportional to energy savings | Cheaper models consume less energy and cost less |
| Context efficiency | Reduced bloat under pressure | Compaction triggered when context exceeds 60% of window |
| Observability | Full visibility into every decision | Human-readable reasons on every policy decision, JSONL telemetry |

The key insight is that most agent turns don't need maximum reasoning or the
most expensive model. Energy-aware mode uses the full budget where it counts
(complex reasoning, tool orchestration) and conserves on routine turns
(simple responses, status checks).

### Quick Integration Guide

How to quickly extend the agent capabilities of **Pi** dependent code to leverage these capabilities

**Step 1: Set your API key**

```bash
export NEURALWATT_API_KEY="your-key-here"
```

**Step 2: Create an energy-aware session** (3 lines of config)

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { EnergyAwarePolicy } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

const { session } = await createAgentSession({
   model: getModel("neuralwatt", "mistralai/Devstral-Small-2-24B-Instruct-2512"),
   policy: new EnergyAwarePolicy(),
   budget: { energy_budget_joules: 50 },
   availableModels: [
      getModel("neuralwatt", "Qwen/Qwen3.5-35B-A3B"),        // cheapest
      getModel("neuralwatt", "mistralai/Devstral-Small-2-24B-Instruct-2512"),
      getModel("neuralwatt", "Qwen/Qwen3.5-397B-A17B-FP8"),  // most capable
   ],
});
```

That's it. The policy handles everything automatically:
- Under 30% budget used: no intervention, full performance
- 30-50%: reasoning depth reduced
- 50-70%: output tokens capped, context compacted if bloated
- 70-100%: routed to cheaper model
- 100%+: agent stops with a clear reason

**Step 3: Read energy data from responses** (optional)

```typescript
// After any agent interaction, energy is on the assistant message
const lastMessage = session.agent.state.messages.at(-1);
if (lastMessage?.role === "assistant" && lastMessage.energy) {
   console.log(`Energy: ${lastMessage.energy.energy_joules.toFixed(2)} J`);
   console.log(`Duration: ${lastMessage.energy.duration_seconds.toFixed(2)} s`);
}
```

**Step 4: Run benchmarks** (optional)

```bash
# Compare both modes
cd packages/benchmarks && node dist/cli.js run --compare

# Live demo with energy meter
npm run demo:coding -w packages/benchmarks
```

### Without the SDK

If you're using the `Agent` class directly instead of `createAgentSession`:

```typescript
import { Agent, EnergyAwarePolicy } from "@mariozechner/pi-agent-core";

const agent = new Agent({
   initialState: { model, thinkingLevel: "high", ... },
   policy: new EnergyAwarePolicy(),
   availableModels: neuralwattModels,
   budget: { energy_budget_joules: 100 },
});
```

Or at the lowest level with `agentLoop()`:

```typescript
import { agentLoop } from "@mariozechner/pi-agent-core";

const stream = agentLoop(prompts, context, {
   model,
   policy: new EnergyAwarePolicy(),
   availableModels: neuralwattModels,
   budget: { energy_budget_joules: 100 },
   onCompact: async (messages) => yourCompactionLogic(messages),
   convertToLlm: yourConverter,
});
```

### Custom Policies

Implement `RuntimePolicy` to create your own policy:

```typescript
import type { RuntimePolicy, PolicyContext, PolicyDecision, UsageWithEnergy } from "@mariozechner/pi-agent-core";

const myPolicy: RuntimePolicy = {
   name: "my-custom-policy",
   beforeModelCall(ctx: PolicyContext): PolicyDecision {
      // your logic — return {} for no intervention
      if (ctx.consumedEnergy > 75) {
         return { abort: true, reason: "Custom limit reached" };
      }
      return {};
   },
   afterModelCall(ctx: PolicyContext, usage: UsageWithEnergy): void {
      // log, track, alert — whatever you need
   },
};
```

---

## Architecture

Energy awareness is implemented across five layers, each in a separate package:

```
┌─────────────────────────────────────────────────────────┐
│  packages/coding-agent   SDK layer                      │
│  createAgentSession({ policy, budget, availableModels })│
├─────────────────────────────────────────────────────────┤
│  packages/agent          Agent + policy layer           │
│  Agent class ──► agentLoop ──► beforeModelCall          │
│                              ◄── afterModelCall         │
│  policy/                                                │
│    BaselinePolicy      (no-op, logs only)               │
│    EnergyAwarePolicy   (5-strategy chain)               │
├─────────────────────────────────────────────────────────┤
│  packages/ai             Provider layer                 │
│  streamSimpleOpenAICompletions()                        │
│    └── extracts energy_joules/energy_kwh from response  │
│    └── attaches EnergyUsage to AssistantMessage.energy  │
├─────────────────────────────────────────────────────────┤
│  packages/benchmarks     Benchmark layer                │
│  Runner, tasks, demos, report generation                │
└─────────────────────────────────────────────────────────┘
```

Data flows bottom-up:
1. Provider extracts energy fields from LLM response
2. Agent loop reads `AssistantMessage.energy` and feeds it to the policy
3. Policy decides whether to intervene (reduce reasoning, cap tokens, route
   to a cheaper model, compact context, or abort)
4. Agent loop applies the decision to the next model call
5. SDK exposes configuration to callers

---

## Type System

### EnergyUsage (`packages/ai/src/types.ts`)

Per-request energy data returned by providers that support it.

```typescript
interface EnergyUsage {
   energy_joules: number;   // energy consumed for this request
   energy_kwh: number;      // same value in kWh (1 kWh = 3,600,000 J)
   duration_seconds: number; // server-side processing time
}
```

Attached to `AssistantMessage` as an optional field:

```typescript
interface AssistantMessage {
   // ... existing fields ...
   energy?: EnergyUsage;
}
```

### buildAssistantMessage() (`packages/ai/src/types.ts`)

Factory function that constructs `AssistantMessage` with all current fields.
Downstream consumers should use this instead of object literals to avoid
silently dropping optional fields like `energy` as the type evolves.

```typescript
function buildAssistantMessage(params: {
   content: AssistantMessage["content"];
   api: Api;
   provider: Provider;
   model: string;
   usage: Usage;
   stopReason: StopReason;
   energy?: EnergyUsage;
   errorMessage?: string;
   timestamp?: number;
}): AssistantMessage;
```

### TelemetryRecord (`packages/ai/src/energy-types.ts`)

Structured telemetry schema for per-call logging. One JSON object per line
(JSONL format).

```typescript
interface TelemetryRecord {
   task_id: string;
   run_id: string;
   step_id: string;
   model: string;
   provider: string;
   tokens: { input: number; output: number; total: number };
   latency_ms: number;
   energy_joules: number;
   energy_kwh: number;
   timestamp: number;
}
```

**Utility functions** (all in `packages/ai/src/energy-types.ts`):

| Function | Description |
|----------|-------------|
| `buildTelemetryRecord(input: TelemetryInput)` | Convert model call results to a `TelemetryRecord`. Defaults missing energy to 0. |
| `serializeTelemetryRecord(record)` | Serialize to a single JSONL line (no trailing newline) |
| `parseTelemetryRecord(line)` | Parse and validate a single JSONL line. Throws on invalid/missing fields. |
| `appendTelemetryLine(lines, record)` | Append a serialized record to an array |
| `parseTelemetryLines(content)` | Parse multi-line JSONL content, skipping empty lines |

`TelemetryInput` is the input shape for `buildTelemetryRecord()`:

```typescript
interface TelemetryInput {
   task_id: string;
   run_id: string;
   step_id: string;
   model: string;
   provider: string;
   usage: Usage;
   energy?: EnergyUsage;
   latency_ms: number;
   timestamp?: number; // defaults to Date.now()
}
```

### Policy Types (`packages/agent/src/policy/types.ts`)

```typescript
interface EnergyBudget {
   energy_budget_joules?: number;
   time_budget_ms?: number;
}

interface PolicyContext {
   taskId?: string;
   turnNumber: number;
   model: Model<any>;
   availableModels: Model<any>[]; // sorted by cost.output ascending
   budget: EnergyBudget;
   consumedEnergy: number;        // joules consumed so far
   consumedTime: number;          // milliseconds elapsed since run start
   messageCount: number;
   estimatedInputTokens: number;  // from last AssistantMessage.usage.totalTokens
}

interface PolicyDecision {
   model?: Model<any>;       // override model for this call
   maxTokens?: number;       // override maxTokens
   reasoning?: ThinkingLevel; // override reasoning level
   shouldCompact?: boolean;  // request context compaction
   abort?: boolean;          // stop the agent loop
   reason?: string;          // human-readable explanation
}

interface UsageWithEnergy {
   input: number;
   output: number;
   totalTokens: number;
   cost: { total: number };
   energy_joules?: number;
   energy_kwh?: number;
}

interface RuntimePolicy {
   name: string;
   beforeModelCall(ctx: PolicyContext): PolicyDecision;
   afterModelCall(ctx: PolicyContext, usage: UsageWithEnergy): void;
}
```

All policy types are exported from `@mariozechner/pi-agent-core` and
re-exported from `@mariozechner/pi-coding-agent`.

---

## Provider Integration

### Neuralwatt Provider

Neuralwatt is registered as an OpenAI-compatible provider.

**Configuration:**
- Provider name: `"neuralwatt"`
- API: `openai-completions`
- Base URL: `https://api.neuralwatt.com/v1`
- API key env var: `NEURALWATT_API_KEY`
- Compat: `supportsStore: false`, `supportsDeveloperRole: false`,
  `supportsReasoningEffort: false`, `maxTokensField: "max_tokens"`

**Registered Models** (in `packages/ai/src/models.generated.ts`):

| Model ID | Context Window | Max Output | Capabilities |
|----------|---------------|------------|--------------|
| `mistralai/Devstral-Small-2-24B-Instruct-2512` | 262,144 | 16,384 | tool_calling |
| `openai/gpt-oss-20b` | 16,384 | 4,096 | tool_calling |
| `moonshotai/Kimi-K2.5` | 262,144 | — | tool_calling |
| `MiniMaxAI/MiniMax-M2.5` | — | — | tool_calling |
| `Qwen/Qwen3.5-397B-A17B-FP8` | 262,144 | — | tool_calling |
| `Qwen/Qwen3.5-35B-A3B` | — | — | tool_calling |
| `zai-org/GLM-5-FP8` | — | — | tool_calling |

All models include per-token pricing from `portal.neuralwatt.com`.

### Energy Data Extraction (`packages/ai/src/providers/openai-completions.ts`)

Energy fields are parsed from the streaming response's `usage` object at
lines 133-145 of `openai-completions.ts`:

```typescript
// Parse energy telemetry from Neuralwatt (or any compatible provider)
const usageAny = chunk.usage as unknown as Record<string, unknown>;
const energyJoules =
   typeof usageAny.energy_joules === "number" ? usageAny.energy_joules : undefined;
const energyKwh =
   typeof usageAny.energy_kwh === "number" ? usageAny.energy_kwh : undefined;
const durationSeconds =
   typeof usageAny.duration_seconds === "number" ? usageAny.duration_seconds : undefined;

if (energyJoules !== undefined || energyKwh !== undefined) {
   output.energy = {
      energy_joules: energyJoules ?? (energyKwh! * 3_600_000),
      energy_kwh: energyKwh ?? (energyJoules! / 3_600_000),
      duration_seconds: durationSeconds ?? 0,
   };
}
```

**Key behaviors:**
- Only numeric values are accepted (type guards reject strings, nulls, etc.)
- At least one of `energy_joules` or `energy_kwh` must be present to populate
  `output.energy`
- If only one field is provided, the other is computed via unit conversion
  (`1 kWh = 3,600,000 J`)
- `duration_seconds` defaults to 0 if not provided
- When neither energy field is present, `AssistantMessage.energy` remains
  `undefined` — graceful degradation, no crashes
- This works with **any** OpenAI-compatible provider that includes energy
  fields in the usage response, not just Neuralwatt

---

## Policy Framework

### RuntimePolicy Interface

All policies implement the `RuntimePolicy` interface:

```typescript
interface RuntimePolicy {
   name: string;
   beforeModelCall(ctx: PolicyContext): PolicyDecision;
   afterModelCall(ctx: PolicyContext, usage: UsageWithEnergy): void;
}
```

- `beforeModelCall` is called before each LLM call. Returns a `PolicyDecision`
  that can override model, maxTokens, reasoning level, or trigger
  compaction/abort.
- `afterModelCall` is called after each LLM call completes. Receives the
  actual usage (including energy) for the policy to update its internal state.

### BaselinePolicy (`packages/agent/src/policy/baseline-policy.ts`)

No-op policy for establishing baseline measurements.

- **Name:** `"baseline"`
- `beforeModelCall()` — always returns `{}` (no interventions)
- `afterModelCall()` — logs `{ ctx, usage }` to internal `_log` array
- `log` getter — returns `ReadonlyArray<{ ctx: PolicyContext; usage: UsageWithEnergy }>`

Use this as the control group when benchmarking.

### EnergyAwarePolicy (`packages/agent/src/policy/energy-aware-policy.ts`)

Adaptive policy with a five-stage strategy chain. Strategies are evaluated
in order on every turn; multiple can fire simultaneously.

**Budget pressure** drives all decisions:

```
pressure = consumedEnergy / energy_budget_joules
```

Falls back to time-based pressure (`consumedTime / time_budget_ms`) if no
energy budget is set. Returns 0 (no intervention) if neither budget is set.

#### Strategy 1: Reasoning Reduction (pressure > 30%)

Scales reasoning level down as pressure increases. Only applies to models
with `reasoning: true`.

| Pressure | Reasoning Level |
|----------|----------------|
| > 30% | `"medium"` |
| > 60% | `"low"` |
| > 80% | `"minimal"` |

Available levels: `["high", "medium", "low", "minimal"]`

#### Strategy 2: Token Limit Reduction (pressure > 50%)

Reduces `maxTokens` by up to 40%, scaling linearly with pressure.

```
reductionFactor = min(0.4, ((pressure - 0.5) / 0.5) * 0.4)
newMaxTokens = floor(model.maxTokens * (1 - reductionFactor))
```

| Pressure | Reduction |
|----------|-----------|
| 50% | 0% |
| 75% | 20% |
| 100% | 40% (capped) |

#### Strategy 3: Model Routing (pressure > 70%)

Routes to the cheapest model from `availableModels` that supports the
required capabilities.

**Capability checks:**
- If current model has `reasoning: true`, candidate must too
- If current model has `"image"` in `input`, candidate must too

**Cost check:** Only routes if `candidate.cost.output < current.cost.output`

**Selection:** `availableModels` must be pre-sorted by `cost.output`
ascending. The policy picks the first candidate that meets all requirements.

#### Strategy 4: Context Compaction (pressure > 50% AND estimatedInputTokens > 60% of contextWindow)

Sets `decision.shouldCompact = true` when the context is growing too large
under budget pressure. The agent loop invokes the `onCompact` callback if
one is configured.

The context window check uses the effective model (i.e. the routed model
if Strategy 3 fired, otherwise the current model).

#### Strategy 5: Budget Exhaustion (pressure >= 100%)

Short-circuits all other strategies. Sets `decision.abort = true` with a
reason message. The agent loop creates a synthetic abort message and stops.

#### Observability

Every decision includes a human-readable `reason` string. Examples:

```
"reasoning: high -> medium (pressure 45%)"
"maxTokens: 16384 -> 11469 (-30%, pressure 75%)"
"model: Qwen3.5-397B -> Devstral-24B (cost 1.327 -> 0.15, pressure 82%)"
"budget exhausted: pressure 105%"
```

The `afterModelCall` hook logs `{ ctx, usage }` to an internal `_log` array
accessible via the `log` getter.

---

## Agent Loop Integration

### PolicyState (`packages/agent/src/agent-loop.ts`)

Mutable state tracked across the agent loop for policy context:

```typescript
interface PolicyState {
   turnNumber: number;
   consumedEnergy: number;       // cumulative joules
   consumedTime: number;         // milliseconds since run start
   estimatedInputTokens: number; // from last AssistantMessage.usage.totalTokens
   startTime: number;            // Date.now() at loop start
}
```

### Before Model Call

On each turn:
1. Increment `turnNumber`, update `consumedTime`
2. Build `PolicyContext` from current state
3. Call `policy.beforeModelCall(ctx)` if configured
4. **Abort handling:** If `decision.abort`, emit a synthetic "Budget exhausted"
   `AssistantMessage` with `stopReason: "aborted"` and end the loop
5. **Compaction:** If `decision.shouldCompact && config.onCompact`, invoke
   `config.onCompact(currentContext.messages)` and replace the context
6. **Model override:** Use `decision.model` if set, otherwise `config.model`
7. **Options override:** Apply `decision.maxTokens` and `decision.reasoning`
   to the stream options
8. **API key resolution:** Resolve API key for the effective model's provider
   (important when routing to a different provider)

### After Model Call

After the LLM response completes:
1. Extract `energy` from `AssistantMessage.energy`
2. Build `UsageWithEnergy` from usage + energy fields
3. Accumulate `energy_joules` to `policyState.consumedEnergy`
4. Update `estimatedInputTokens` from `usage.totalTokens`
5. Call `policy.afterModelCall(ctx, usageWithEnergy)`

### AgentLoopConfig Fields (`packages/agent/src/types.ts`)

```typescript
interface AgentLoopConfig extends SimpleStreamOptions {
   // ... existing fields ...

   /** Optional runtime policy for energy-aware budgeting. */
   policy?: RuntimePolicy;

   /** Models available for policy-driven routing, sorted by cost.output ascending. */
   availableModels?: Model<any>[];

   /** Energy/time budget for policy-driven enforcement. */
   budget?: EnergyBudget;

   /** Called when the policy requests context compaction. */
   onCompact?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
}
```

---

## SDK Integration

### Agent Class (`packages/agent/src/agent.ts`)

The high-level `Agent` class accepts policy configuration through `AgentOptions`
and forwards it to the agent loop:

```typescript
interface AgentOptions {
   // ... existing fields ...

   policy?: RuntimePolicy;
   availableModels?: Model<any>[];
   budget?: EnergyBudget;
   onCompact?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
}
```

Runtime accessors allow mid-session changes:

```typescript
agent.policy = new EnergyAwarePolicy();
agent.availableModels = neuralwattModels;
agent.budget = { energy_budget_joules: 100 };
```

### createAgentSession (`packages/coding-agent/src/core/sdk.ts`)

The top-level SDK function accepts and forwards policy config:

```typescript
interface CreateAgentSessionOptions {
   // ... existing fields ...

   policy?: RuntimePolicy;
   availableModels?: Model<any>[];
   budget?: EnergyBudget;
   onCompact?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
}
```

**Re-exports** from pi-coding-agent (so consumers can import from one place):

```typescript
export type { EnergyBudget, RuntimePolicy } from "@mariozechner/pi-agent-core";
export type { EnergyUsage } from "@mariozechner/pi-ai";
```

### Usage Example

```typescript
import {
   createAgentSession,
   type EnergyBudget,
} from "@mariozechner/pi-coding-agent";
import { EnergyAwarePolicy } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

// Gather Neuralwatt models sorted by output cost
const availableModels = [
   getModel("neuralwatt", "Qwen/Qwen3.5-35B-A3B"),
   getModel("neuralwatt", "mistralai/Devstral-Small-2-24B-Instruct-2512"),
   getModel("neuralwatt", "Qwen/Qwen3.5-397B-A17B-FP8"),
].sort((a, b) => a.cost.output - b.cost.output);

const { session } = await createAgentSession({
   model: availableModels[0], // start with cheapest
   policy: new EnergyAwarePolicy(),
   availableModels,
   budget: { energy_budget_joules: 50 },
   onCompact: async (messages) => {
      // your compaction logic here
      return messages.slice(-10);
   },
});
```

---

## Benchmark Harness

The `packages/benchmarks` package provides a mock-based benchmark runner
for comparing baseline vs energy-aware modes without live API calls.

### Types (`packages/benchmarks/src/types.ts`)

```typescript
/** Task definition */
interface BenchmarkTask {
   id: string;
   name: string;
   description: string;
   prompt: string;
   tools?: AgentTool[];
   maxTurns: number;
   mockTurnUsage?: MockTurnUsage[]; // per-turn overrides for mocked runs
   validator: (
      records: TelemetryRecord[],
      decisions: PolicyDecisionLog[],
   ) => { passed: boolean; score: number; reason: string };
}

/** Aggregated result for a single task run */
interface TaskResult {
   task_id: string;
   run_id: string;
   mode: "baseline" | "energy-aware";
   passed: boolean;
   score: number;
   time_ms: number;
   energy_joules: number;
   tokens_total: number;
   turns: number;
   policy_decisions: PolicyDecisionLog[];
}

/** Log entry for a single policy decision */
interface PolicyDecisionLog {
   turn: number;
   pressure: number;
   reason: string;
   actions: string[]; // e.g. ["route:model-id", "reasoning:medium", "compact", "abort"]
}

/** Side-by-side comparison for one task */
interface TaskComparison {
   task_id: string;
   task_name: string;
   baseline: TaskResult;
   energy_aware: TaskResult;
   energy_savings_pct: number;
   time_delta_pct: number;
}

/** Full benchmark report */
interface BenchmarkReport {
   run_date: string;
   baseline_run_id: string;
   energy_aware_run_id: string;
   tasks: TaskComparison[];
   aggregate: {
      mean_energy_savings_pct: number;
      mean_time_delta_pct: number;
      baseline_success_rate: number;
      energy_aware_success_rate: number;
   };
}

/** Runner configuration */
interface RunConfig {
   runId?: string;
   mode: "baseline" | "energy-aware";
   model: Model<Api>;
   availableModels: Model<Api>[];
   budget: EnergyBudget;
   policy?: RuntimePolicy;
}
```

### Runner (`packages/benchmarks/src/runner.ts`)

The runner simulates agent loop turns using mocked usage data:

1. For each turn, builds a `PolicyContext` with current state
2. Calls `policy.beforeModelCall(ctx)` — records the decision
3. Checks for abort
4. Simulates model call using `MockTurnUsage` data
5. Calls `policy.afterModelCall(ctx, usage)`
6. Accumulates energy and tokens
7. After all turns, calls the task's `validator` with collected telemetry

Default mock usage per turn: 500 input tokens, 200 output tokens,
0.5 joules, 100ms latency.

### Output Files

| File | Format | Description |
|------|--------|-------------|
| `results.jsonl` | JSONL | Per-call telemetry records |
| `summary.csv` | CSV | Per-task aggregated results |
| `report.md` | Markdown | Human-readable comparison report with verdict |

### Scripts

```bash
# Run baseline only
cd packages/benchmarks && node dist/cli.js run --mode baseline

# Run energy-aware only
cd packages/benchmarks && node dist/cli.js run --mode energy-aware

# Run both and generate comparison report
cd packages/benchmarks && node dist/cli.js run --compare
```

---

## Live Demos

### Demo 1: Coding Agent Energy Challenge

```bash
npm run demo:coding -w packages/benchmarks
```

Runs a real coding agent task in both modes with a live energy meter showing
budget pressure, strategy activations, and model routing in real-time.

Energy consumption is reported from real API telemetry (`energy_joules` in the
Neuralwatt SSE stream). If a run returns no energy data a warning is printed and
that run is recorded as 0 J.

### Demo 2: HackerNews Energy-Aware Watcher

```bash
npm run demo:hn -w packages/benchmarks
```

Runs a continuous HackerNews relevance monitor for AI-related topics,
comparing energy consumption between modes over 3 minutes.

---

## Testing

### Energy Telemetry Tests (`packages/ai/test/energy-telemetry.test.ts`)

- `buildTelemetryRecord()` — complete data, missing energy (defaults to 0),
  timestamp fallback to `Date.now()`
- Serialization/deserialization round-trip fidelity
- JSONL batch parsing with empty line skipping
- Schema contract validation — all required fields present

### Energy Metrics Tests (`packages/ai/test/energy-metrics.test.ts`)

- Parsing `energy_joules` and `energy_kwh` from mock OpenAI-compatible
  streaming responses
- Unit conversion: `joules / 3,600,000 = kWh` and reverse
- Graceful handling: `energy` is `undefined` when no fields present
- Non-numeric field rejection (strings, nulls)
- Provider-agnostic: any OpenAI-compatible provider can include energy fields

### BaselinePolicy Tests (`packages/agent/test/policy/baseline-policy.test.ts`)

- `beforeModelCall()` always returns empty decision
- `afterModelCall()` logs telemetry correctly
- Accumulation of multiple calls
- Identical agent behavior to no-policy execution
- Graceful handling of missing energy data

### EnergyAwarePolicy Tests (`packages/agent/test/policy/energy-aware-policy.test.ts`)

- Pressure calculation: energy vs time budget priority
- Strategy 1: reasoning reduction at 30%, 60%, 80% thresholds
- Strategy 2: token reduction linear scaling, 40% cap
- Strategy 3: model routing with capability checks (reasoning, image),
  cost filtering, sorted selection
- Strategy 4: context compaction threshold (60% of context window)
- Strategy 5: budget exhaustion abort at 100%

### Policy Hooks Integration Tests (`packages/agent/test/policy/policy-hooks.test.ts`)

- Agent loop + policy interaction with mock policies
- Abort handling: agent stops when policy returns `abort: true`
- Decision application: model, maxTokens, reasoning overrides applied
- State updates: energy accumulation, turn counting

---

## Acceptance Criteria

Energy-aware mode must:
- Achieve **>=80% energy reduction** compared to baseline across the
  benchmark task suite
- Maintain **<=5% success rate degradation** compared to baseline
- Never crash when energy telemetry is missing (graceful fallback to
  baseline behavior)

---

## Downstream Integration (openclaw)

See [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md) for the full
integration plan. All pi-mono preparatory work is complete. The remaining
work is on the openclaw side:

1. Fix `buildAssistantMessage()` in openclaw to include the `energy` field
2. Fix `normalizeUsage()` to propagate energy data in the result pipeline
3. Wire `policy`, `availableModels`, `budget` through session creation
4. Connect `onCompact` to openclaw's existing compaction extension
5. Add telemetry persistence
6. Re-export energy types from the plugin SDK
