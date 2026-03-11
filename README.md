# Energy-Aware Pi Monorepo
This is a hard fork of the Pi monorepo where we are baking in the concept of energy-awareness to agents.  What's energy-awareness? 
Well its essentially making decisions based on the energy & power constriants in your envioronment.  For example we have extending the 
Pi coding agent to make semantic model routing decisions based on the expected energy/performance tradeoff of that action.  There are many 
other examples we've outlined here: [ENERGY_AWARENESS.md](ENERGY_AWARENESS.md).

This is what the demo energy-aware coding agent looks like in action:
<img width="1717" height="1492" alt="EADemo" src="https://github.com/user-attachments/assets/da7b32ae-7eaa-4146-b5f6-96905d4adb4f" />

And this is the demo HN watcher agent looks like in action:
<img width="712" height="812" alt="HN" src="https://github.com/user-attachments/assets/7767e808-7931-44a8-aa4a-b2219bdf919d" />

You can run these from the packages/benchmarks directory and currently they are designed to inspire thinking and to show what is possible
with energy awareness.  We may think about integrating these capabilities to other tools at some point.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (must be run from repo root)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
