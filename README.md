# Energy-Aware Pi Monorepo
This is a hard fork of the Pi monorepo where we are baking in the concept of energy-awareness to agents.  What's energy-awareness? 
Well its essentially making decisions based on the energy & power constriants in your envioronment.  For example we have extending the 
Pi coding agent to make semantic model routing decisions based on the expected energy/performance tradeoff of that action.  There are many 
other examples we've outlined below. 

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
