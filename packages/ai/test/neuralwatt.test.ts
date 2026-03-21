import { beforeEach, describe, expect, it } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels, getProviders } from "../src/models.js";
import type { Model } from "../src/types.js";

describe("Neuralwatt provider configuration", () => {
	describe("model registry", () => {
		it("should include neuralwatt in the list of providers", () => {
			const providers = getProviders();
			expect(providers).toContain("neuralwatt");
		});

		it("should have Qwen3.5 397B model", () => {
			const model = getModel("neuralwatt", "Qwen/Qwen3.5-397B-A17B-FP8");
			expect(model).toBeDefined();
			expect(model.id).toBe("Qwen/Qwen3.5-397B-A17B-FP8");
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("neuralwatt");
			expect(model.baseUrl).toBe("https://api.neuralwatt.com/v1");
			expect(model.input).toContain("text");
			expect(model.contextWindow).toBe(262144);
			expect(model.maxTokens).toBeGreaterThan(0);
		});

		it("should have GPT-OSS 20B model", () => {
			const model = getModel("neuralwatt", "openai/gpt-oss-20b");
			expect(model).toBeDefined();
			expect(model.id).toBe("openai/gpt-oss-20b");
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("neuralwatt");
			expect(model.baseUrl).toBe("https://api.neuralwatt.com/v1");
			expect(model.input).toEqual(["text"]);
			expect(model.contextWindow).toBe(16384);
			expect(model.maxTokens).toBeGreaterThan(0);
		});

		it("should have GPT-OSS cost lower than Qwen 397B", () => {
			const large = getModel("neuralwatt", "Qwen/Qwen3.5-397B-A17B-FP8");
			const small = getModel("neuralwatt", "openai/gpt-oss-20b");
			expect(small.cost.output).toBeLessThan(large.cost.output);
			expect(small.cost.input).toBeLessThan(large.cost.input);
		});

		it("should return all neuralwatt models via getModels", () => {
			const models = getModels("neuralwatt");
			expect(models.length).toBeGreaterThanOrEqual(5);
			const ids = models.map((m: Model<"openai-completions">) => m.id);
			expect(ids).toContain("openai/gpt-oss-20b");
			expect(ids).toContain("Qwen/Qwen3.5-397B-A17B-FP8");
			expect(ids).toContain("mistralai/Devstral-Small-2-24B-Instruct-2512");
		});
	});

	describe("env-api-keys", () => {
		const originalEnv = process.env;

		beforeEach(() => {
			process.env = { ...originalEnv };
		});

		it("should return NEURALWATT_API_KEY when set", () => {
			process.env.NEURALWATT_API_KEY = "nw-test-key-123";
			const key = getEnvApiKey("neuralwatt");
			expect(key).toBe("nw-test-key-123");
		});

		it("should return undefined when NEURALWATT_API_KEY is not set", () => {
			delete process.env.NEURALWATT_API_KEY;
			const key = getEnvApiKey("neuralwatt");
			expect(key).toBeUndefined();
		});
	});

	describe.skipIf(!process.env.NEURALWATT_API_KEY || !process.env.NEURALWATT_INTEGRATION)(
		"OpenAI-compatible streaming (integration)",
		() => {
			it("should complete a chat request through Neuralwatt endpoint", { timeout: 30000 }, async () => {
				const { complete } = await import("../src/stream.js");
				const model = getModel("neuralwatt", "mistralai/Devstral-Small-2-24B-Instruct-2512");
				const response = await complete(model, {
					systemPrompt: "You are a helpful assistant. Be concise.",
					messages: [
						{ role: "user", content: "Reply with exactly: 'Hello test successful'", timestamp: Date.now() },
					],
				});
				expect(response.role).toBe("assistant");
				expect(response.content.length).toBeGreaterThan(0);
				expect(response.usage.output).toBeGreaterThan(0);
			});
		},
	);

	describe("model compat settings", () => {
		it("should have conservative compat settings for neuralwatt models", () => {
			const model = getModel("neuralwatt", "Qwen/Qwen3.5-397B-A17B-FP8");
			expect(model.compat).toBeDefined();
			expect(model.compat!.supportsStore).toBe(false);
			expect(model.compat!.supportsDeveloperRole).toBe(false);
			expect(model.compat!.supportsReasoningEffort).toBe(false);
			expect(model.compat!.maxTokensField).toBe("max_tokens");
		});
	});
});
