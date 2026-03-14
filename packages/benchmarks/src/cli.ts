import { parseArgs } from "node:util";
import { BaselinePolicy } from "@mariozechner/pi-agent-core";
import { getModels, type Model } from "@mariozechner/pi-ai";
import { runSuite } from "./runner.js";
import { getTasksByGlob } from "./tasks.js";
import type { RunConfig } from "./types.js";

/**
 * Neuralwatt models from the generated registry, sorted by cost.output ascending.
 */
const NEURALWATT_MODELS: Model<"openai-completions">[] = (
	getModels("neuralwatt") as Model<"openai-completions">[]
).sort((a, b) => a.cost.output - b.cost.output);

function printUsage(): void {
	console.log(`Usage: bench run [options]

Options:
  --mode <mode>           Run mode: baseline, energy-aware, or compare (default: compare)
  --tasks <glob>          Task glob filter (default: all tasks)
  --budget-joules <n>     Energy budget in joules
  --budget-ms <n>         Time budget in milliseconds
  --output <dir>          Output directory (default: ./results)
  --help                  Show this help message
`);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			mode: { type: "string", default: "compare" },
			tasks: { type: "string" },
			"budget-joules": { type: "string" },
			"budget-ms": { type: "string" },
			output: { type: "string", default: "./results" },
			help: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	if (values.help) {
		printUsage();
		process.exit(0);
	}

	const mode = values.mode as "baseline" | "energy-aware" | "compare";
	const budgetJoules = values["budget-joules"] ? Number(values["budget-joules"]) : undefined;
	const budgetMs = values["budget-ms"] ? Number(values["budget-ms"]) : undefined;
	const defaultModel = NEURALWATT_MODELS[NEURALWATT_MODELS.length - 1];

	const tasks = getTasksByGlob(values.tasks as string | undefined);

	const baseConfig: RunConfig = {
		mode: "baseline",
		model: defaultModel,
		availableModels: NEURALWATT_MODELS,
		budget: {
			energy_budget_joules: budgetJoules,
			time_budget_ms: budgetMs,
		},
		policy: new BaselinePolicy(),
	};

	if (mode === "baseline" || mode === "compare") {
		console.log("Running baseline...");
		const baselineResult = await runSuite(tasks, baseConfig);
		console.log(
			`Baseline: ${baselineResult.results.length} tasks, ${baselineResult.results.filter((r) => r.passed).length} passed`,
		);

		for (const result of baselineResult.results) {
			console.log(
				`  ${result.task_id}: ${result.passed ? "PASS" : "FAIL"} (${result.energy_joules.toFixed(3)}J, ${result.turns} turns)`,
			);
		}
	}

	if (mode === "energy-aware" || mode === "compare") {
		// Energy-aware mode will use EnergyAwarePolicy once T2.3 is complete
		// For now, use BaselinePolicy as a placeholder
		const energyConfig: RunConfig = {
			...baseConfig,
			mode: "energy-aware",
			policy: new BaselinePolicy(), // Placeholder — replaced when EnergyAwarePolicy is ready
		};

		console.log("Running energy-aware...");
		const energyResult = await runSuite(tasks, energyConfig);
		console.log(
			`Energy-aware: ${energyResult.results.length} tasks, ${energyResult.results.filter((r) => r.passed).length} passed`,
		);

		for (const result of energyResult.results) {
			console.log(
				`  ${result.task_id}: ${result.passed ? "PASS" : "FAIL"} (${result.energy_joules.toFixed(3)}J, ${result.turns} turns)`,
			);
		}
	}
}

main().catch((err) => {
	console.error("Benchmark runner failed:", err);
	process.exit(1);
});
