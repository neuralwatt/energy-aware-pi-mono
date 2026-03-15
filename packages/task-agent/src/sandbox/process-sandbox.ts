import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutionRequest, ExecutionResult, SandboxProvider } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

const EXTENSION_MAP: Record<ExecutionRequest["language"], string> = {
	typescript: ".ts",
	javascript: ".js",
	python: ".py",
};

export class ProcessSandbox implements SandboxProvider {
	async execute(request: ExecutionRequest): Promise<ExecutionResult> {
		const { code, language, timeout_ms = DEFAULT_TIMEOUT_MS, stdin } = request;

		const tempDir = await mkdtemp(join(tmpdir(), "sandbox-"));
		const ext = EXTENSION_MAP[language];
		const filePath = join(tempDir, `script${ext}`);

		await writeFile(filePath, code, "utf-8");

		try {
			return await this.run(filePath, language, timeout_ms, stdin);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	private run(
		filePath: string,
		language: ExecutionRequest["language"],
		timeoutMs: number,
		stdin?: string,
	): Promise<ExecutionResult> {
		const [cmd, args] = this.getCommand(filePath, language);
		const start = performance.now();

		return new Promise<ExecutionResult>((resolve) => {
			const child = execFile(
				cmd,
				args,
				{ timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
				(error, stdout, stderr) => {
					const duration_ms = Math.round(performance.now() - start);
					const timed_out = error !== null && "killed" in error && error.killed === true;

					let exit_code = 0;
					if (error !== null) {
						if ("code" in error && typeof error.code === "number") {
							exit_code = error.code;
						} else if (timed_out) {
							exit_code = 124; // conventional timeout exit code
						} else {
							exit_code = 1;
						}
					}

					resolve({
						stdout: String(stdout),
						stderr: String(stderr),
						exit_code,
						duration_ms,
						timed_out,
					});
				},
			);

			if (stdin !== undefined && child.stdin) {
				child.stdin.write(stdin);
				child.stdin.end();
			}
		});
	}

	private getCommand(filePath: string, language: ExecutionRequest["language"]): [string, string[]] {
		switch (language) {
			case "typescript":
				return ["npx", ["tsx", filePath]];
			case "javascript":
				return ["node", [filePath]];
			case "python":
				return ["python3", [filePath]];
		}
	}
}
