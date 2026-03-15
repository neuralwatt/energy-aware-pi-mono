# Task Agent Architecture

## Motivation

pi-mono's agent loop (`packages/agent`) is purpose-built for coding tasks: it edits files, runs shell commands, and operates on a filesystem. We want to generalize agent capabilities to solve **arbitrary structured problems** — constraint satisfaction, optimization, data transformation, test-driven code generation — where the agent decomposes a problem, writes and executes candidate solutions, evaluates results, and recursively refines its approach.

This document defines the architecture for a **Task Agent** runtime that:
- Reuses pi-mono's LLM streaming, tool interface, and policy hooks (no forks, no renames)
- Lives in a new package to avoid merge conflicts with upstream pi-mono
- Serves as the general-purpose agent layer that Fugue (and other consumers) can build on
- Is a **stateless problem-solving engine** — it does not persist anything, does not know about other users or runs

## Scope Boundary: Pi-Mono vs Fugue

This package owns the **mechanics of solving a single problem in a single session**. It does not own cross-session memory, multi-user collaboration, or knowledge persistence.

The boundary is two hooks:

```
Fugue (or any consumer)
   |
   |-- priorKnowledge[] --> TaskAgent --> onArtifact() --> Fugue (or any consumer)
   |                           |
   |                           v
   |                      TaskResult + StrategyRecord[] + lessons
```

- **`priorKnowledge`** (input): Lessons from prior runs, other users, or institutional memory. The task agent consumes these but doesn't produce or store them. Fugue populates this from its context graph. Benchmarks can use a lightweight JSON file (like the existing `demo-memory.ts` pattern).
- **`onArtifact`** (output): Callback fired when the agent produces a persistable artifact (strategy record, lesson, solution). Fugue writes these to the context graph. Benchmarks write to JSONL or terminal.

See `FUGUE_TASK_AGENT_ARCHITECTURE.md` in the Fugue repo for how Fugue consumes these interfaces.

## Design Constraints

1. **Merge-safe**: No modifications to existing `packages/agent/` or `packages/ai/` files. New package only.
2. **Reuse, don't fork**: Import `AgentTool`, `RuntimePolicy`, `PolicyContext`, streaming infrastructure — don't copy them.
3. **Energy-aware by default**: Every task agent run can be policy-governed (baseline or energy-aware).
4. **Composable tools**: Consumers (Fugue, benchmarks) register domain-specific tools alongside builtins.
5. **Observable**: The agent emits structured events that any consumer can render (terminal, canvas, logs).
6. **Stateless**: No database, no persistent state, no multi-user awareness. Clean inputs, clean outputs.

## Package Structure

```
packages/task-agent/
   package.json
   tsconfig.json
   src/
      index.ts                    # public API barrel
      task-agent.ts               # main orchestration loop
      types.ts                    # TaskAgent-specific types
      tool-registry.ts            # composable tool collection
      sandbox/
         types.ts                 # SandboxProvider interface
         process-sandbox.ts       # child_process with timeout + resource limits
      tools/
         run-code.ts              # execute code in sandbox, return output
         validate.ts              # run a validator function against a candidate
         spawn-sub-agent.ts       # recursive agent spawning with budget splitting
      decomposition/
         types.ts                 # Strategy, Attempt, Evaluation, BacktrackReason
         loop.ts                  # decompose -> attempt -> evaluate -> revise cycle
   test/
      task-agent.test.ts
      tool-registry.test.ts
      sandbox/
         process-sandbox.test.ts
      tools/
         run-code.test.ts
         validate.test.ts
      decomposition/
         loop.test.ts
```

## Core Types

### TaskAgent

The top-level orchestrator. Unlike the coding agent loop which runs turn-by-turn until the LLM stops, the task agent runs a **goal-directed loop** with explicit decomposition and evaluation phases.

```typescript
import type { AgentTool, AgentLoopConfig } from "@mariozechner/agent"
import type { RuntimePolicy, EnergyBudget } from "@mariozechner/agent/policy"
import type { Model } from "@mariozechner/ai"

interface TaskAgentConfig {
   /** The problem to solve, in natural language or structured format */
   task: string

   /** Tools available to this agent (builtins + domain-specific) */
   tools: ToolRegistry

   /** Energy/time budget governance */
   policy?: RuntimePolicy
   budget?: EnergyBudget
   availableModels?: Model<any>[]

   /** Model to use for primary reasoning */
   model: Model<any>

   /** Model for lightweight classification/validation (discriminator) */
   classifierModel?: Model<any>

   /** Maximum recursive decomposition depth */
   maxDepth?: number  // default: 5

   /** Maximum total LLM calls before forced termination */
   maxCalls?: number  // default: 50

   /** Abort signal for cancellation */
   signal?: AbortSignal

   /** Lessons from prior runs on similar problems.
    *  Fugue populates this from the context graph.
    *  Benchmarks leave it empty or use a lightweight JSON file. */
   priorKnowledge?: PriorKnowledge[]

   /** Callback when the agent produces a persistable artifact.
    *  Fugue writes these to the graph. Benchmarks write to JSONL. */
   onArtifact?: (artifact: AgentArtifact) => Promise<void>
}

interface PriorKnowledge {
   source: string              // "previous_run" | "team_member" | "institutional_memory"
   problem_similarity: string  // why this knowledge is relevant
   lessons: string[]           // what was learned
   strategies_to_avoid?: string[]
   strategies_that_worked?: string[]
}

type AgentArtifact =
   | { type: "strategy"; data: StrategyRecord }
   | { type: "lesson"; data: BacktrackReason }
   | { type: "solution"; data: { solution: unknown; validation: ValidationResult } }

interface TaskResult {
   status: "solved" | "failed" | "aborted" | "budget_exhausted"
   solution?: unknown
   strategies_tried: StrategyRecord[]
   total_calls: number
   total_energy_joules: number
   total_duration_ms: number
   reason?: string
}
```

### Tool Registry

A composable collection that lets consumers mix builtin tools with domain-specific ones. Not a global singleton — each agent instance gets its own registry.

```typescript
import type { AgentTool } from "@mariozechner/agent"

class ToolRegistry {
   private tools: Map<string, AgentTool<any>>

   register(tool: AgentTool<any>): void
   unregister(name: string): void
   get(name: string): AgentTool<any> | undefined
   list(): AgentTool<any>[]

   /** Merge another registry (e.g., domain tools on top of builtins) */
   merge(other: ToolRegistry): ToolRegistry
}
```

This reuses the existing `AgentTool` interface from `packages/agent` — same TypeBox schemas, same `execute()` signature, same streaming updates. No new tool interface needed.

### Sandbox

Isolated code execution for candidate solutions. The agent writes code, the sandbox runs it, the agent evaluates the output.

```typescript
interface SandboxProvider {
   execute(request: ExecutionRequest): Promise<ExecutionResult>
}

interface ExecutionRequest {
   code: string
   language: "typescript" | "python" | "javascript"
   timeout_ms?: number   // default: 30000
   memory_mb?: number    // default: 256
   stdin?: string
}

interface ExecutionResult {
   stdout: string
   stderr: string
   exit_code: number
   duration_ms: number
   timed_out: boolean
}
```

**MVP implementation: `ProcessSandbox`** — spawns a child process with `setTimeout` for kill. No Docker dependency. Sufficient for trusted code (agent-generated solutions to well-defined problems). A `DockerSandbox` implementation can be added later for untrusted execution.

### Decomposition Loop

The core recursive cycle. This is what makes the task agent different from a simple chat loop.

```typescript
interface Strategy {
   id: string
   name: string           // e.g., "greedy-by-room-capacity"
   approach: string       // natural language description of the approach
   parent_id?: string     // if this is a refinement of a prior strategy
   depth: number
}

interface Attempt {
   strategy: Strategy
   code: string           // the candidate solution code
   execution: ExecutionResult
   validation: ValidationResult
}

interface ValidationResult {
   passed: boolean
   score?: number          // 0-1, for partial credit
   violations: string[]    // specific constraint violations
   details?: unknown       // validator-specific structured output
}

interface BacktrackReason {
   strategy_id: string
   failure_type: "wrong_approach" | "partial_solution" | "runtime_error" | "timeout"
   lesson: string         // what the agent learned (fed back into next attempt)
}

interface StrategyRecord {
   strategy: Strategy
   attempts: Attempt[]
   backtrack_reason?: BacktrackReason
   duration_ms: number
   energy_joules: number
}
```

### Events

The task agent emits structured events that any consumer can observe. These extend (not replace) the existing `AgentEvent` types from `packages/agent`.

```typescript
type TaskAgentEvent =
   | { type: "task_start"; task: string; config: Partial<TaskAgentConfig> }
   | { type: "task_end"; result: TaskResult }
   | { type: "strategy_start"; strategy: Strategy }
   | { type: "strategy_end"; strategy: Strategy; outcome: "success" | "backtrack" }
   | { type: "attempt_start"; strategy_id: string; attempt_number: number }
   | { type: "attempt_end"; attempt: Attempt }
   | { type: "backtrack"; reason: BacktrackReason }
   | { type: "code_execution"; request: ExecutionRequest; result: ExecutionResult }
   | { type: "validation"; result: ValidationResult }
   | { type: "sub_agent_spawn"; child_task: string; depth: number; budget: EnergyBudget }
   | { type: "budget_warning"; pressure: number; action: string }
```

Events are delivered via an `onEvent` callback (same pattern as the existing agent loop's streaming). Consumers wire this to their rendering layer:
- `packages/benchmarks`: renders to terminal (like the coding-agent demo)
- Fugue: renders to canvas as graph nodes via WebSocket

## Orchestration Flow

```
                    +------------------+
                    |   task_start     |
                    +--------+---------+
                             |
                    +--------v---------+
                    |  Inject prior    |  Feed priorKnowledge[] into
                    |  knowledge       |  the system prompt
                    +--------+---------+
                             |
                    +--------v---------+
                    |  LLM: decompose  |  "Given this problem and these constraints,
                    |  the problem     |   propose a solving strategy."
                    +--------+---------+
                             |
                    +--------v---------+
                    | strategy_start   |  Record the chosen approach
                    | onArtifact()     |  Emit strategy artifact
                    +--------+---------+
                             |
              +--------------v--------------+
              |  LLM: generate solution     |  "Write code that implements
              |  code using tools           |   this strategy."
              +--------------+--------------+
                             |
              +--------------v--------------+
              |  run_code (sandbox)         |  Execute candidate in sandbox
              +--------------+--------------+
                             |
              +--------------v--------------+
              |  validate (deterministic)   |  Check against problem spec
              +--------------+--------------+
                             |
                    +--------v---------+
                    |  Passed?         |
                    +--+------------+--+
                       |            |
                   YES |            | NO
                       |            |
              +--------v---+  +-----v-----------+
              | onArtifact |  | LLM: analyze    |  "The greedy approach failed
              | task_end   |  | failure, decide |   because speaker X has 3
              | (solved)   |  | next strategy   |   conflicts. Try backtracking
              +------------+  +-----+-----------+   with MRV heuristic."
                                    |
                              +-----v-----------+
                              | backtrack       |  Record lesson learned
                              | onArtifact()    |  Emit lesson artifact
                              +-----+-----------+
                                    |
                              +-----v-----------+
                              | depth/budget    |
                              | check           |
                              +--+----------+---+
                                 |          |
                             OK  |          | EXCEEDED
                                 |          |
                        +--------v---+ +----v-------+
                        | loop back  | | task_end   |
                        | to decomp  | | (failed)   |
                        +------------+ +------------+
```

### Key Design Decisions

**1. LLM drives strategy selection, not hardcoded heuristics.**
The agent loop doesn't contain domain-specific algorithms. It asks the LLM to propose approaches, write code, and analyze failures. The recursion emerges from the LLM's reasoning, not from a fixed state machine.

**2. Validation is deterministic, not LLM-based.**
The validator is a pure function provided by the problem spec. The agent can't hallucinate a passing result. This creates the hard feedback signal that forces genuine backtracking.

**3. Lessons accumulate across attempts.**
Each `BacktrackReason` includes a `lesson` string. The full history of lessons is fed into the next decomposition prompt, so the agent genuinely learns from failures within a single run.

**4. Energy policy governs the meta-level, not just individual calls.**
The discriminator routes cheap calls (validation checks, simple classification) to small models and reserves expensive models for strategy reasoning. Budget pressure can force the agent to try simpler approaches or terminate early.

**5. The agent is stateless.**
All persistent knowledge flows through `priorKnowledge` (in) and `onArtifact` (out). The task agent never reads from or writes to a database. This keeps it testable, composable, and consumer-agnostic.

## Builtin Tools

These ship with `packages/task-agent` and are available to all task agents:

### `run_code`
Execute code in the sandbox. Returns stdout, stderr, exit code. The agent uses this to test candidate solutions.

```typescript
// Parameters (TypeBox schema)
{
   code: Type.String({ description: "Code to execute" }),
   language: Type.Union([
      Type.Literal("typescript"),
      Type.Literal("python"),
      Type.Literal("javascript"),
   ]),
}

// Returns
{
   stdout: string,
   stderr: string,
   exit_code: number,
   duration_ms: number,
}
```

### `validate_solution`
Run the problem's validator against a candidate solution. The validator is injected by the problem spec, not by the agent.

```typescript
// Parameters
{
   solution: Type.Unknown({ description: "The candidate solution to validate" }),
}

// Returns
{
   passed: boolean,
   score: number,
   violations: string[],
}
```

### `record_strategy`
Declare what approach the agent is about to try. Creates a `Strategy` record in the run history.

```typescript
// Parameters
{
   name: Type.String({ description: "Short name for the strategy" }),
   approach: Type.String({ description: "Description of the approach" }),
   parent_id: Type.Optional(Type.String({ description: "ID of the strategy this refines" })),
}
```

### `record_lesson`
Record what was learned from a failed attempt, so future strategies can avoid the same mistake.

```typescript
// Parameters
{
   strategy_id: Type.String(),
   failure_type: Type.Union([
      Type.Literal("wrong_approach"),
      Type.Literal("partial_solution"),
      Type.Literal("runtime_error"),
      Type.Literal("timeout"),
   ]),
   lesson: Type.String({ description: "What was learned from this failure" }),
}
```

## Demos

Three demo problems ship with `packages/benchmarks`, each stressing different aspects of the recursive problem-solving loop. All three run in both baseline and energy-aware modes for comparison.

### Demo 1: Conference Scheduling (Constraint Satisfaction)

**Stresses:** Hard backtracking, deterministic pass/fail, strategy pivoting.

The agent must schedule 20 talks across 5 rooms with speaker conflicts, time preferences, equipment requirements, and capacity constraints.

**Why it forces recursion:**
- Greedy assignment hits speaker conflicts around talk 8-10
- Simple backtracking works but is slow — the agent learns to apply constraint propagation
- The hard problem variant is intentionally over-constrained, requiring the agent to identify which constraints are unsatisfiable

**Validator:** Pure function checking completeness, no double-booking, no speaker conflicts, capacity, equipment, sequencing. Returns `{ passed, score, violations[] }`.

**Energy-aware angle:** The discriminator routes constraint-checking calls (lightweight, structural) to cheap models and reserves expensive models for strategy reasoning ("why did greedy fail? what should I try next?").

```
packages/benchmarks/src/demos/scheduling/
   problem.ts          # TypeScript types for the problem
   validator.ts        # Deterministic constraint checker
   generator.ts        # Generate random problems of varying difficulty
   problems/
      small.json       # 5 talks, 2 rooms (smoke test)
      medium.json      # 20 talks, 5 rooms (the demo)
      hard.json        # 50 talks, 10 rooms, tight constraints
```

### Demo 2: Code from Tests (Iterative Refinement)

**Stresses:** Iterative debugging, partial scores, incremental convergence.

The agent receives a function signature, docstring, and a test suite (10-20 test cases). It writes an implementation, runs the tests, sees which fail, fixes bugs, and iterates until all tests pass.

**Why it forces recursion:**
- Unlike constraint satisfaction, the agent doesn't pivot strategy entirely — it patches and refines
- Partial evaluation provides gradient: 3/10 passing -> 7/10 -> 9/10 -> debug the last edge case
- Some test cases reveal algorithmic inadequacy (e.g., O(n^2) solution times out on large input), forcing a strategy-level rethink mid-refinement

**Validator:** The test suite itself. Runs via sandbox, parses test output. Returns `{ passed: all_green, score: tests_passing / total_tests, violations: [failing test names + assertion messages] }`.

**Problem tiers:**
- **Easy:** Pure function, simple logic (e.g., "implement a function that merges overlapping intervals")
- **Medium:** Requires data structure choice (e.g., "implement an LRU cache with O(1) get/put")
- **Hard:** Requires algorithmic insight + edge case handling (e.g., "implement a function that finds the longest palindromic substring")

**Energy-aware angle:** Early attempts (likely wrong, broad exploration) use cheap models. As the solution converges and needs subtle debugging ("why does test 9 fail when the input contains duplicate keys?"), the discriminator escalates to expensive models. Budget pressure can also force the agent to submit a partial solution (7/10 passing) rather than burning energy on the last edge case.

```
packages/benchmarks/src/demos/code-from-tests/
   problem.ts          # ProblemSpec type: signature, docstring, test code
   validator.ts        # Runs test suite in sandbox, parses results
   problems/
      merge-intervals.ts    # Easy
      lru-cache.ts          # Medium
      longest-palindrome.ts # Hard
```

### Demo 3: Data Pipeline Synthesis (Decomposition + Composition)

**Stresses:** Sub-problem decomposition, composable steps, output-diff validation.

The agent receives input data (JSON array), a set of transformation rules described in natural language, and expected output. It writes a data transformation pipeline that produces the expected output from the input.

**Example problem:**
> Input: sales records (JSON array with date, region, product, amount)
> Rules: "Group by region. Compute a rolling 7-day average of amount per region. Flag any day where the amount exceeds 2 standard deviations from the rolling average. Output the flagged records with the average and deviation."
> Expected output: JSON array of flagged records with computed fields.

**Why it forces recursion:**
- Each transformation step is independently solvable, but the pipeline must compose correctly
- The agent must decompose the problem into steps (group -> window -> stats -> filter -> format)
- Individual steps may work in isolation but produce wrong intermediate shapes, requiring the agent to debug the composition
- Strategy diversity: imperative loops vs functional chains vs streaming approaches — the agent may try one, find it unwieldy, and switch

**Validator:** Compares actual output against expected output. Row-by-row comparison with tolerance for floating-point fields. Returns `{ passed: exact_match, score: matching_rows / total_rows, violations: ["row 5: expected average=142.3, got 141.9", ...] }`.

**Problem tiers:**
- **Easy:** Single transformation (e.g., "filter and sort")
- **Medium:** 3-4 chained transformations with intermediate aggregation
- **Hard:** 5+ transformations including window functions, statistical computation, and self-referential joins

**Energy-aware angle:** Each transformation step can be generated independently with a cheap model (simple, well-defined sub-task). Only the composition phase — debugging why step 3's output doesn't match step 4's expected input — needs the expensive model. The discriminator naturally routes: "write a group-by function" -> cheap; "the pipeline produces 47 rows but expected 52, figure out where records are being dropped" -> expensive.

```
packages/benchmarks/src/demos/data-pipeline/
   problem.ts          # PipelineProblem type: input data, rules[], expected output
   validator.ts        # Output comparison with tolerance
   generator.ts        # Generate random datasets + transformation chains
   problems/
      filter-sort.json        # Easy
      rolling-average.json    # Medium
      anomaly-detection.json  # Hard
```

### Demo Coverage Matrix

| Aspect of the Loop | Scheduling | Code from Tests | Data Pipeline |
|---|---|---|---|
| Hard backtracking | Primary | Rare | Moderate |
| Iterative refinement | Low | Primary | Moderate |
| Sub-problem decomposition | Low | Low | Primary |
| Partial/gradient scoring | No (pass/fail) | Yes (tests passing) | Yes (rows matching) |
| Strategy diversity | Medium | Low | High |
| Composition debugging | No | No | Yes |
| Energy discrimination | Strategy vs checking | Early vs late attempts | Step generation vs composition |

If the architecture supports all three cleanly, the decomposition loop is genuinely general — not accidentally shaped around constraint satisfaction.

## Consumer Integration

### Benchmarks (standalone demo)

```typescript
import { TaskAgent, ToolRegistry, ProcessSandbox, runCodeTool, validateTool } from "@neuralwatt/task-agent"
import { EnergyAwarePolicy } from "@mariozechner/agent/policy"
import { getModel } from "@mariozechner/ai"

// Load problem
const problem = loadSchedulingProblem("medium.json")

// Build tool registry
const tools = new ToolRegistry()
tools.register(runCodeTool(new ProcessSandbox()))
tools.register(validateTool(problem.validator))

// Run with prior knowledge (optional, from demo-memory.ts)
const priorKnowledge = loadDemoMemory("scheduling")

const agent = new TaskAgent({
   task: problem.description,
   tools,
   model: getModel("neuralwatt", "kimi-k2.5"),
   classifierModel: getModel("neuralwatt", "gpt-oss-20b"),
   policy: new EnergyAwarePolicy(),
   budget: { energy_budget_joules: 500 },
   maxDepth: 5,
   priorKnowledge,
   onArtifact: (a) => saveToDemoMemory("scheduling", a),
})

for await (const event of agent.run()) {
   renderToTerminal(event)  // live progress in terminal
}
```

### Fugue (canvas integration, future)

```typescript
import { TaskAgent, ToolRegistry, ProcessSandbox, runCodeTool } from "@neuralwatt/task-agent"

// Fugue queries its context graph for relevant prior knowledge
const priorKnowledge = await graphClient.queryRelevantLessons(taskDescription)

// Fugue adds domain tools on top of builtins
const tools = new ToolRegistry()
tools.register(runCodeTool(new ProcessSandbox()))
tools.register(createNodeTool(graphClient))       // Fugue-specific
tools.register(queryGraphTool(graphClient))       // Fugue-specific

const agent = new TaskAgent({
   task: userPromptFromCanvas,
   tools,
   model,
   policy: new EnergyAwarePolicy(),
   budget: canvasBudgetSettings,
   priorKnowledge,
   onArtifact: (a) => graphClient.persistArtifact(a),  // write to context graph
})

for await (const event of agent.run()) {
   await broadcastToCanvas(event)  // render as graph nodes on Excalidraw canvas
}
```

## Relationship to Existing Packages

```
packages/ai/          <-- upstream, not modified
   Stream, Model, Tool, EnergyUsage, providers

packages/agent/       <-- upstream, not modified
   AgentTool, AgentEvent, RuntimePolicy,
   PolicyContext, EnergyBudget, agent-loop

packages/task-agent/  <-- NEW (this package)
   TaskAgent, ToolRegistry, ProcessSandbox,
   decomposition loop, builtin tools
   Imports from: ai, agent
   Exports: types for consumers (PriorKnowledge, AgentArtifact, TaskResult)

packages/benchmarks/  <-- existing, extended
   scheduling/, code-from-tests/, data-pipeline/ demos
   Imports from: ai, agent, task-agent
```

No files in `packages/ai/` or `packages/agent/` are modified. The task-agent package depends on them via workspace references and imports their exported types. When upstream pi-mono updates `packages/agent/`, the merge is clean because we haven't touched those files.

## Build Sequence

### Phase 1: Foundation
1. Scaffold `packages/task-agent/` (package.json, tsconfig, index.ts)
2. `ToolRegistry` class + tests
3. `ProcessSandbox` + tests
4. `run_code` tool wired to sandbox + tests

### Phase 2: Agent Loop
5. `TaskAgent` orchestrator with basic loop (no decomposition yet — just LLM + tools)
6. Wire `RuntimePolicy` (reuse from packages/agent)
7. Event emission (TaskAgentEvent stream)
8. `priorKnowledge` injection into system prompt
9. `onArtifact` callback wiring
10. Integration test: agent solves a trivial problem (e.g., "sort this list")

### Phase 3: Decomposition
11. Strategy/Attempt/Backtrack types
12. Decomposition loop (the recursive cycle)
13. `record_strategy` and `record_lesson` tools
14. Lesson accumulation across attempts
15. Integration test: agent solves a problem that requires backtracking

### Phase 4: Demos
16. Demo 1 — Scheduling: problem spec, validator, generator, small/medium/hard problems
17. Demo 2 — Code from Tests: problem spec, test-suite validator, easy/medium/hard problems
18. Demo 3 — Data Pipeline: problem spec, output-diff validator, easy/medium/hard problems
19. Energy-aware policy + discriminator integration for all three
20. Cross-run learning via demo-memory.ts (lightweight PriorKnowledge persistence)

### Phase 5: Fugue Bridge (not in this repo)
21. Fugue registers graph tools into ToolRegistry
22. Fugue implements PriorKnowledge from context graph queries
23. Fugue implements onArtifact as graph persistence
24. TaskAgentEvent -> canvas node rendering
25. Human-in-the-loop (pause/steer from canvas)
