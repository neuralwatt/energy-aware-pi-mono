# Energy-Aware Pi Monorepo

This is a hard fork of the [Pi monorepo](https://github.com/badlogic/pi-mono) where we are extending the agent framework to support energy-awareness. What's energy-awareness?
It's essentially making decisions based on the energy & power constraints in your environment. For example we have extended the
Pi coding agent to make model routing decisions based on the expected energy/performance tradeoff of that action. There are many
other examples we've outlined here: [ENERGY_AWARENESS.md](ENERGY_AWARENESS.md).

The actual per-request energy values come from the Neuralwatt AI model platform here: https://portal.neuralwatt.com/

This is what the demo energy-aware coding agent looks like in action:
```bash
npm run demo:coding -w packages/benchmarks
```
<img width="1717" height="1492" alt="EADemo" src="https://github.com/user-attachments/assets/da7b32ae-7eaa-4146-b5f6-96905d4adb4f" />

And this is the demo HN watcher agent looks like in action:
```bash
npm run demo:hn -w packages/benchmarks
```
<img width="712" height="812" alt="HN" src="https://github.com/user-attachments/assets/7767e808-7931-44a8-aa4a-b2219bdf919d" />

Both demos require `NEURALWATT_API_KEY` to be set. They are designed to inspire thinking and to show what is possible with energy awareness.

Pass flags after a `--` separator (required by npm to forward args to the script):
```bash
npm run demo:coding -w packages/benchmarks -- --runs 4 --hard
npm run demo:coding -w packages/benchmarks -- --clear-memory
npm run demo:hn -w packages/benchmarks -- --duration 60 --fast
```

# Energy Observability
The energy data coming back from the supported APIs is useful for billing, dashboards and compliance. Paired with location information (available from
info@neuralwatt.com on request) it can also be used for Scope 3 carbon accounting.

# Energy-aware Policy Framework
We implement a RuntimePolicy interface that anyone can implement to help make intelligent agent decisions. We provide an energy-aware policy which
implements a set of heuristics to make optimal tradeoffs on how models are called and which models are used for various sub-tasks in the agent to maintain
problem convergence while dramatically reducing the energy required for those tasks. On task failure we aggressively upgrade the capabilities to larger and
more capable models as wasting time on requests which aren't converging isn't productive from an energy use point of view. In the initial demos we've created
we've found that solution convergence takes roughly the same amount of sub-tasks while using dramatically less energy (in many cases <80%).

These capabilities are being integrated into OpenClaw — see [OPENCLAW_INTEGRATION.md](OPENCLAW_INTEGRATION.md)

## What Changed from Upstream

| Package | Changes |
|---------|---------|
| `packages/ai` | `EnergyUsage` type on `AssistantMessage`, energy extraction from OpenAI-compatible responses, `TelemetryRecord` JSONL schema, `buildAssistantMessage()` helper, Neuralwatt provider + models |
| `packages/agent` | `RuntimePolicy` interface, `BaselinePolicy`, `EnergyAwarePolicy` (5-strategy chain), policy hooks in agent loop (`beforeModelCall`/`afterModelCall`), `onCompact` callback, `policy`/`budget`/`availableModels` on `Agent` and `AgentLoopConfig` |
| `packages/coding-agent` | `createAgentSession` accepts policy config, re-exports energy types |
| `packages/benchmarks` | New package — benchmark runner, task definitions, comparison reports, live demos |

All changes are additive and opt-in. When no policy is configured, behavior is identical to upstream pi-mono.

## Quickstart

```bash
export NEURALWATT_API_KEY="your-key-here"
```

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { EnergyAwarePolicy } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

const { session } = await createAgentSession({
   model: getModel("neuralwatt", "mistralai/Devstral-Small-2-24B-Instruct-2512"),
   policy: new EnergyAwarePolicy(),
   budget: { energy_budget_joules: 50 },
   availableModels: [
      getModel("neuralwatt", "Qwen/Qwen3.5-35B-A3B"),
      getModel("neuralwatt", "mistralai/Devstral-Small-2-24B-Instruct-2512"),
      getModel("neuralwatt", "Qwen/Qwen3.5-397B-A17B-FP8"),
   ],
});
```

See [ENERGY_AWARENESS.md](ENERGY_AWARENESS.md) for the full implementation reference.

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@mariozechner/pi-benchmarks](packages/benchmarks)** | Energy-aware benchmark runner and demos (fork-only) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License
Fork of: [https://github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono)
MIT
