# OpenClaw Integration: Energy Awareness

This document tracks the work needed to bring energy awareness features from
`energy-aware-pi-mono` into the `openclaw` project.

## Background

openclaw depends on 4 pi-mono packages (`@earendil-works/pi-ai`,
`@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`), all at v0.57.1 (published as `@neuralwatt/*`).

All energy-aware changes are additive and opt-in — no existing APIs were broken.
However, openclaw's internal patterns create friction that must be addressed on
the **openclaw** side. All pi-mono preparatory work is complete.

---

## Pi-mono Preparatory Work (all complete)

| Task | Description | Status |
|------|-------------|--------|
| P1 | `buildAssistantMessage()` factory in pi-ai — constructs AssistantMessage with all fields including `energy` | Done |
| P2 | `createAgentSession` in pi-coding-agent accepts `policy`, `availableModels`, `budget`, `onCompact` and forwards to Agent | Done |
| P3 | `onCompact` callback on `AgentLoopConfig` — agent loop invokes it when policy sets `shouldCompact: true` | Done |
| P4 | Energy types exported from package entry points (`EnergyUsage`, `EnergyBudget`, `RuntimePolicy`, etc.) | Done |
| P5 | CHANGELOG entries documenting `energy` passthrough requirement for downstream consumers | Done |
| P6 | `Agent` class accepts and forwards `policy`, `availableModels`, `budget`, `onCompact` via `AgentOptions` + runtime accessors | Done |
| P7 | pi-coding-agent re-exports `EnergyBudget`, `RuntimePolicy`, `EnergyUsage` so openclaw can import from a single package | Done |
| P8 | Fixed pre-existing type errors (openai SDK `phase` field, missing `extract-zip` types) so `npm run check` passes clean | Done |

---

## Remaining Work (openclaw side)

### Critical — must fix for energy data to flow

#### 1. `buildAssistantMessage()` drops the `energy` field

**Where:** `openclaw/src/agents/stream-message-shared.ts`

openclaw's `buildAssistantMessage()` constructs a new `AssistantMessage` with
explicit fields and does **not** pass through the `energy` property. The
`energy?: EnergyUsage` field added to `AssistantMessage` in pi-ai is silently
discarded.

**Fix:** Add `energy` to the params type and the returned object. Or switch to
using `buildAssistantMessage()` from `@earendil-works/pi-ai` (exported as P1).

```typescript
// In stream-message-shared.ts buildAssistantMessage():
return {
  role: "assistant",
  content: params.content,
  stopReason: params.stopReason,
  api: params.model.api,
  provider: params.model.provider,
  model: params.model.id,
  usage: params.usage,
  energy: params.energy,           // <-- add this
  timestamp: params.timestamp ?? Date.now(),
};
```

#### 2. `normalizeUsage()` drops energy data in result pipeline

**Where:** `openclaw/src/agents/usage.ts` and `pi-embedded-runner/run.ts`

The usage normalization pipeline (`toNormalizedUsage`, `normalizeUsage`)
extracts specific token fields by name and reconstructs a new object.
Energy data from the original `AssistantMessage` is lost when building
`EmbeddedPiAgentMeta`.

**Fix:** When building `EmbeddedPiAgentMeta`, propagate `energy` from the
last `AssistantMessage` alongside the normalized usage.

### High Priority — needed for energy-aware mode

#### 3. Wire policy config through openclaw's session creation

**Where:** `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`

openclaw calls `createAgentSession()` with explicit named parameters. Now that
`createAgentSession` accepts `policy`, `availableModels`, `budget`, and
`onCompact` (P2), openclaw needs to pass them.

**Fix:** Add optional energy-aware config to openclaw's session creation path
and forward to `createAgentSession()`.

#### 4. Connect compaction signal to openclaw's compaction extension

**Where:** openclaw's context pruning / compaction extension

The `onCompact` callback (P3) lets the agent loop notify the caller when the
policy wants compaction. openclaw already has context pruning and compaction
extensions but they're not connected to this signal.

**Fix:** When constructing `createAgentSession` options, provide an `onCompact`
callback that triggers openclaw's existing compaction mechanism.

#### 5. Model routing coordination

openclaw has its own model routing logic (provider-specific stream wrappers,
gateway model selection). The `EnergyAwarePolicy` can also route to a different
model via `PolicyDecision.model`.

**Resolution:** These are complementary, not conflicting:
- openclaw's routing selects the **initial** model and provider config
- The policy's routing selects a **cheaper alternative** from `availableModels`
  under budget pressure
- openclaw should populate `availableModels` with Neuralwatt models sorted by
  `cost.output` ascending, letting the policy pick from that pre-filtered set

No code fix needed — just pass the right `availableModels` when configuring
the session.

### Medium Priority — nice to have

#### 6. Plugin SDK does not re-export energy types

**Where:** `openclaw/src/plugin-sdk/index.ts`

openclaw's plugin SDK does not re-export any pi-ai or pi-agent-core types.
Plugin authors who want to consume energy data must import directly from
`@earendil-works/pi-ai` or `@earendil-works/pi-coding-agent`.

**Fix:** Re-export `EnergyUsage`, `EnergyBudget`, `RuntimePolicy`,
`PolicyDecision` from the plugin SDK.

#### 7. Telemetry pipeline not wired

pi-mono's `TelemetryRecord` and JSONL serialization (`energy-types.ts`) have
no consumer in openclaw. Telemetry records need a destination.

**Fix:** Use `SessionManager.appendCustomEntry()` to persist telemetry records
per session, or write to a separate JSONL file.

#### 8. Tool execute signature variance

openclaw uses two `execute` signatures for tools:
- `(toolCallId, params, signal?, onUpdate?)`
- `(toolCallId, params, onUpdate?, ctx?, signal?)`

The agent loop in pi-mono uses the first signature. The `TaskAgent`
orchestrator (if openclaw ever uses it) would need tools matching that
signature.

**Fix:** Not blocking — openclaw's tools work with the agent loop today.
Only matters if adopting `TaskAgent` directly.

---

## Integration Sequence

Recommended order of operations:

1. **Bump openclaw's pi-mono deps** to the energy-aware fork
2. **Fix `buildAssistantMessage()`** in openclaw (issue #1) — smallest change,
   biggest impact
3. **Fix `normalizeUsage()`** energy propagation (issue #2)
4. **Wire policy config** through openclaw's session creation (issue #3)
5. **Connect compaction signal** (issue #4)
6. **Add telemetry persistence** (issue #7)
7. **Re-export types** from plugin SDK (issue #6)
8. **Test end-to-end** with Neuralwatt models and energy budgets
