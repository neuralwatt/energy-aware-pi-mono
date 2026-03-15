export interface ValidationResult {
	passed: boolean;
	score?: number;
	violations: string[];
}

export function validatePipelineOutput(expected: unknown[], actual: unknown[], tolerance?: number): ValidationResult {
	const tol = tolerance ?? 0.01;
	const violations: string[] = [];

	if (actual.length !== expected.length) {
		violations.push(`Expected ${expected.length} rows but got ${actual.length}`);
		// Still compare what we can
		const minLen = Math.min(expected.length, actual.length);
		let matching = 0;
		for (let i = 0; i < minLen; i++) {
			const rowViolations = compareRow(expected[i], actual[i], i, tol);
			if (rowViolations.length === 0) {
				matching++;
			} else {
				violations.push(...rowViolations);
			}
		}
		const score = expected.length > 0 ? matching / expected.length : 0;
		return { passed: false, score, violations };
	}

	let matching = 0;
	for (let i = 0; i < expected.length; i++) {
		const rowViolations = compareRow(expected[i], actual[i], i, tol);
		if (rowViolations.length === 0) {
			matching++;
		} else {
			violations.push(...rowViolations);
		}
	}

	const score = expected.length > 0 ? matching / expected.length : 1;
	return {
		passed: violations.length === 0,
		score,
		violations,
	};
}

function compareRow(expected: unknown, actual: unknown, rowIndex: number, tolerance: number): string[] {
	const violations: string[] = [];

	if (typeof expected !== "object" || expected === null || typeof actual !== "object" || actual === null) {
		if (expected !== actual) {
			violations.push(`Row ${rowIndex}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
		}
		return violations;
	}

	const exp = expected as Record<string, unknown>;
	const act = actual as Record<string, unknown>;

	for (const key of Object.keys(exp)) {
		if (!(key in act)) {
			violations.push(`Row ${rowIndex}: missing field '${key}'`);
			continue;
		}

		const expVal = exp[key];
		const actVal = act[key];

		if (typeof expVal === "number" && typeof actVal === "number") {
			if (Math.abs(expVal - actVal) > tolerance) {
				violations.push(`Row ${rowIndex}: field '${key}' expected ${expVal} got ${actVal}`);
			}
		} else if (expVal !== actVal) {
			violations.push(
				`Row ${rowIndex}: field '${key}' expected ${JSON.stringify(expVal)} got ${JSON.stringify(actVal)}`,
			);
		}
	}

	return violations;
}
