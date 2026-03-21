# OpenClaw Integration: Energy Awareness

This document tracks the work needed to bring energy awareness features from
`energy-aware-pi-mono` into the [openclaw](~/dev/openclaw) project.

## Background

openclaw depends on 4 pi-mono packages (`@mariozechner/pi-ai`,
`@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`,
`@mariozechner/pi-tui`), all at v0.57.1 (published as `@neuralwatt/*`).

All energy-aware changes are additive and opt-in — no existing APIs were broken.
However, openclaw's internal patterns create friction that must be addressed on
**both** sides.

---

## Critical Issues (must fix before integration)

### 1. `buildAssistantMessage()` drops the `energy` field

**Where:** `openclaw/src/agents/stream-message-shared.ts`

openclaw's `buildAssistantMessage()` constructs a new `AssistantMessage` with
explicit fields and does **not** pass through unknown properties. The `energy?:
EnergyUsage` field added to `AssistantMessage` in pi-ai is silently discarded.

**Fix (openclaw side):** Add `energy` to `buildAssistantMessage()`:
```typescript
return {
  role: "assistant",
  content: params.content,
  stopReason: params.stopReason,
  api: params.model.api,
  provider: params.model.provider,
  model: params.model.id,
  usage: params.usage,
  energy: params.energy,           // <-- add
  timestamp: params.timestamp ?? Date.now(),
};
```

**Fix (pi-mono side):** Export a helper that constructs `AssistantMessage` with
all fields so downstream consumers don't have to track new additions manually.
See **Task P1** below.

### 2. Usage construction helpers ignore energy

**Where:** `openclaw/src/agents/stream-message-shared.ts`

`buildZeroUsage()` and `buildUsageWithNoCost()` construct `Usage` objects with
hardcoded field lists. Energy fields on `UsageWithEnergy` are not represented.

**Fix (openclaw side):** These functions produce `Usage` objects (not
`UsageWithEnergy`), which is correct — energy lives on `AssistantMessage.energy`,
not inside `Usage`. No change needed here as long as issue #1 is fixed.

### 3. `normalizeUsage()` drops energy data in result pipeline

**Where:** `openclaw/src/agents/usage.ts` and `pi-embedded-runner/run.ts`

The usage normalization pipeline (`toNormalizedUsage`, `normalizeUsage`)
extracts specific token fields by name and reconstructs a new object.
Energy data from the original `AssistantMessage` is lost.

**Fix (openclaw side):** When building `EmbeddedPiAgentMeta`, propagate
`energy` from the last `AssistantMessage` alongside the normalized usage.

---

## High-Priority Issues

### 4. `createAgentSession` does not pass policy config

**Where:** `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`

openclaw calls `createAgentSession()` with explicit named parameters. There is
no pass-through for `policy`, `availableModels`, or `budget` — the new
`AgentLoopConfig` fields added for energy-aware mode.

**Fix (openclaw side):** Add optional `policy`, `availableModels`, `budget`
params to openclaw's session creation path, passed through to the agent loop.

**Fix (pi-mono side):** Ensure `createAgentSession` in pi-coding-agent
accepts and forwards these fields. See **Task P2** below.

### 5. Model routing conflict

openclaw has its own model routing logic (provider-specific stream wrappers,
gateway model selection). The `EnergyAwarePolicy` can also route to a different
model via `PolicyDecision.model`.

**Resolution:** These are complementary, not conflicting:
- openclaw's routing selects the **initial** model and provider config
- The policy's routing selects a **cheaper alternative** from `availableModels`
  under budget pressure
- openclaw should populate `availableModels` with Neuralwatt models sorted by
  `cost.output` ascending, letting the policy pick from that pre-filtered set

### 6. `shouldCompact` policy decision not wired

The `EnergyAwarePolicy` can set `shouldCompact: true` to request context
compaction. The agent loop does **not** act on this flag — it's left to the
caller. openclaw already has context pruning and compaction extensions, but
they're not connected to the policy signal.

**Fix (openclaw side):** When `shouldCompact` is set in a policy decision,
trigger openclaw's existing compaction extension.

**Fix (pi-mono side):** Add a `shouldCompact` callback to `AgentLoopConfig`
so the agent loop can act on the signal directly. See **Task P3** below.

---

## Medium-Priority Issues

### 7. Plugin SDK does not re-export energy types

**Where:** `openclaw/src/plugin-sdk/index.ts`

openclaw's plugin SDK does not re-export any pi-ai or pi-agent-core types.
Plugin authors who want to consume energy data must import directly from
`@mariozechner/pi-ai`.

**Fix (openclaw side):** Re-export `EnergyUsage`, `EnergyBudget`,
`RuntimePolicy`, `PolicyDecision` from the plugin SDK.

### 8. Telemetry pipeline not wired

pi-mono's `TelemetryRecord` and JSONL serialization (`energy-types.ts`) have
no consumer in openclaw. Telemetry records need a destination.

**Fix (openclaw side):** Use `SessionManager.appendCustomEntry()` to persist
telemetry records per session, or write to a separate JSONL file.

### 9. Tool execute signature variance

openclaw uses two `execute` signatures for tools:
- `(toolCallId, params, signal?, onUpdate?)`
- `(toolCallId, params, onUpdate?, ctx?, signal?)`

The agent loop in pi-mono uses the first signature. The `TaskAgent`
orchestrator (if openclaw ever uses it) would need tools matching that
signature.

**Fix:** Not blocking — openclaw's tools work with the agent loop today.
Only matters if adopting `TaskAgent` directly.

---

## Preparatory Tasks (pi-mono side)

These are code changes in energy-aware-pi-mono that reduce friction for
openclaw integration.

### P1: Add `buildAssistantMessage` helper to pi-ai

Export a factory function that constructs `AssistantMessage` with all current
fields (including `energy`). This gives downstream consumers a single
construction point that stays up to date as the type evolves.

**Status:** Done (branch `openclaw/integration`)

### P2: Forward policy config through `createAgentSession`

Ensure `createAgentSession` in pi-coding-agent accepts `policy`,
`availableModels`, and `budget` and passes them to the agent loop config.

**Status:** TODO (requires pi-coding-agent changes)

### P3: Add `onCompact` callback to `AgentLoopConfig`

When the policy sets `shouldCompact: true`, invoke a caller-provided callback
instead of silently ignoring the signal. This lets openclaw wire it to its
existing compaction extension.

**Status:** Done (branch `openclaw/integration`)

### P4: Export energy types from package entry points

Verify that `EnergyUsage`, `EnergyBudget`, `RuntimePolicy`, `PolicyDecision`,
`UsageWithEnergy`, `TelemetryRecord` are all exported from their respective
package entry points (`packages/ai/src/index.ts`,
`packages/agent/src/index.ts`).

**Status:** Already exported (verified)

### P5: Add `energy` passthrough guidance to CHANGELOG

Document in both `packages/ai/CHANGELOG.md` and `packages/agent/CHANGELOG.md`
that downstream consumers constructing `AssistantMessage` manually must add
the optional `energy` field to avoid silent data loss.

**Status:** Done (branch `openclaw/integration`)

---

## Integration Sequence

Recommended order of operations:

1. **Land pi-mono changes** (P1, P3, P5) — this branch
2. **Bump openclaw's pi-mono deps** to the new version
3. **Fix `buildAssistantMessage()`** in openclaw (issue #1) — smallest change,
   biggest impact
4. **Wire policy config** through openclaw's session creation (issue #4)
5. **Connect compaction signal** (issue #6)
6. **Add telemetry persistence** (issue #8)
7. **Re-export types** from plugin SDK (issue #7)
8. **Test end-to-end** with Neuralwatt models and energy budgets
