import type { PipelineProblem } from "./types.js";

// ---------------------------------------------------------------------------
// Easy: Filter and Sort
// ---------------------------------------------------------------------------

interface SalesRecord {
	date: string;
	region: string;
	product: string;
	amount: number;
	quantity: number;
}

const regions = ["North", "South", "East", "West"] as const;
const products = ["Widget", "Gadget", "Gizmo", "Doohickey", "Thingamajig"] as const;

function generateSalesRecords(): SalesRecord[] {
	const records: SalesRecord[] = [];
	for (let i = 0; i < 20; i++) {
		const region = regions[i % 4];
		const product = products[i % 5];
		const day = (i + 1).toString().padStart(2, "0");
		const amount = 100 + i * 17; // deterministic: 100, 117, 134, ...
		const quantity = 1 + (i % 7);
		records.push({
			date: `2025-01-${day}`,
			region,
			product,
			amount,
			quantity,
		});
	}
	return records;
}

const salesInput = generateSalesRecords();

// West records are at indices 3, 7, 11, 15, 19 (i % 4 === 3)
const easyExpected: SalesRecord[] = salesInput.filter((r) => r.region === "West").sort((a, b) => b.amount - a.amount);

const easyProblem: PipelineProblem = {
	id: "pipeline-easy",
	title: "Filter and Sort",
	description:
		"Given an array of sales records with fields: date, region, product, amount, quantity. " +
		"Filter to only records where region is 'West', then sort by amount in descending order.",
	inputData: salesInput,
	transformRules: ["Filter to region 'West'", "Sort by amount descending"],
	expectedOutput: easyExpected,
	difficulty: "easy",
};

// ---------------------------------------------------------------------------
// Medium: Rolling Average with Grouping
// ---------------------------------------------------------------------------

interface DailyRecord {
	date: string;
	region: string;
	value: number;
}

const mediumRegions = ["Alpha", "Beta", "Gamma"] as const;

function generateDailyRecords(): DailyRecord[] {
	const records: DailyRecord[] = [];
	// 3 regions, 10 days each = 30 records
	// Values are deterministic: base per region + day offset
	const bases = { Alpha: 100, Beta: 200, Gamma: 300 };
	for (const region of mediumRegions) {
		const base = bases[region];
		for (let day = 1; day <= 10; day++) {
			const dayStr = day.toString().padStart(2, "0");
			// Varying but deterministic values
			const value = base + day * 5 + ((day * 7) % 11);
			records.push({
				date: `2025-03-${dayStr}`,
				region,
				value,
			});
		}
	}
	return records;
}

interface RollingAvgRecord {
	date: string;
	region: string;
	value: number;
	rolling_avg: number;
}

function computeMediumExpected(records: DailyRecord[]): RollingAvgRecord[] {
	const result: RollingAvgRecord[] = [];
	for (const region of mediumRegions) {
		const regionRecords = records.filter((r) => r.region === region).sort((a, b) => a.date.localeCompare(b.date));
		for (let i = 0; i < regionRecords.length; i++) {
			const windowStart = Math.max(0, i - 2);
			const window = regionRecords.slice(windowStart, i + 1);
			const avg = window.reduce((sum, r) => sum + r.value, 0) / window.length;
			result.push({
				date: regionRecords[i].date,
				region,
				value: regionRecords[i].value,
				rolling_avg: Math.round(avg * 100) / 100,
			});
		}
	}
	return result;
}

const dailyInput = generateDailyRecords();
const mediumExpected = computeMediumExpected(dailyInput);

const mediumProblem: PipelineProblem = {
	id: "pipeline-medium",
	title: "Rolling Average with Grouping",
	description:
		"Given an array of daily records with fields: date, region, value. " +
		"Group by region, compute a 3-day rolling average of value per region (current day plus up to 2 prior days), " +
		"and round the rolling_avg to 2 decimal places. " +
		"Output records should have fields: date, region, value, rolling_avg. " +
		"Order by region (alphabetical), then by date ascending within each region.",
	inputData: dailyInput,
	transformRules: [
		"Group by region",
		"Compute 3-day rolling average of value per region",
		"Round to 2 decimal places",
	],
	expectedOutput: mediumExpected,
	difficulty: "medium",
	tolerance: 0.01,
};

// ---------------------------------------------------------------------------
// Hard: Anomaly Detection
// ---------------------------------------------------------------------------

interface SensorReading {
	timestamp: string;
	sensor_id: string;
	reading: number;
	unit: string;
}

function generateSensorReadings(): SensorReading[] {
	const records: SensorReading[] = [];
	const sensorIds = ["S1", "S2", "S3", "S4", "S5"];
	const units = ["celsius", "psi", "rpm", "volts", "amps"];

	// For each sensor, generate 10 readings with 2-3 intentional outliers.
	// Base values and spreads are chosen so mean/stddev are clean.
	const sensorConfigs: Array<{ base: number; normal: number[]; outlierIndices: number[]; outlierOffsets: number[] }> =
		[
			{ base: 50, normal: [0, 1, -1, 2, -2, 1, -1], outlierIndices: [3, 7], outlierOffsets: [15, -14] },
			{ base: 100, normal: [0, 2, -2, 3, -3, 1, -1], outlierIndices: [2, 6, 9], outlierOffsets: [20, -18, 22] },
			{ base: 3000, normal: [0, 10, -10, 20, -20, 5, -5], outlierIndices: [1, 8], outlierOffsets: [150, -140] },
			{ base: 220, normal: [0, 3, -3, 5, -5, 2, -2], outlierIndices: [4, 7, 9], outlierOffsets: [30, -28, 32] },
			{ base: 15, normal: [0, 0.5, -0.5, 1, -1, 0.3, -0.3], outlierIndices: [0, 5], outlierOffsets: [8, -7] },
		];

	for (let s = 0; s < 5; s++) {
		const cfg = sensorConfigs[s];
		for (let i = 0; i < 10; i++) {
			const hour = (8 + i).toString().padStart(2, "0");
			let reading: number;
			const outlierIdx = cfg.outlierIndices.indexOf(i);
			if (outlierIdx >= 0) {
				reading = cfg.base + cfg.outlierOffsets[outlierIdx];
			} else {
				// Use normal values cyclically
				const normalIdx = i < cfg.outlierIndices[0] ? i : i - cfg.outlierIndices.filter((oi) => oi < i).length;
				reading = cfg.base + cfg.normal[normalIdx % cfg.normal.length];
			}
			records.push({
				timestamp: `2025-06-15T${hour}:00:00Z`,
				sensor_id: sensorIds[s],
				reading,
				unit: units[s],
			});
		}
	}
	return records;
}

interface FlaggedReading {
	timestamp: string;
	sensor_id: string;
	reading: number;
	unit: string;
	mean: number;
	stddev: number;
	z_score: number;
}

function computeHardExpected(records: SensorReading[]): FlaggedReading[] {
	const sensorIds = ["S1", "S2", "S3", "S4", "S5"];
	const result: FlaggedReading[] = [];

	for (const sensorId of sensorIds) {
		const sensorRecords = records.filter((r) => r.sensor_id === sensorId);
		const readings = sensorRecords.map((r) => r.reading);
		const mean = readings.reduce((s, v) => s + v, 0) / readings.length;
		const variance = readings.reduce((s, v) => s + (v - mean) ** 2, 0) / readings.length;
		const stddev = Math.sqrt(variance);

		for (const rec of sensorRecords) {
			const zScore = stddev === 0 ? 0 : Math.abs(rec.reading - mean) / stddev;
			if (zScore > 2) {
				result.push({
					timestamp: rec.timestamp,
					sensor_id: rec.sensor_id,
					reading: rec.reading,
					unit: rec.unit,
					mean: Math.round(mean * 100) / 100,
					stddev: Math.round(stddev * 100) / 100,
					z_score: Math.round(zScore * 100) / 100,
				});
			}
		}
	}
	return result;
}

const sensorInput = generateSensorReadings();
const hardExpected = computeHardExpected(sensorInput);

const hardProblem: PipelineProblem = {
	id: "pipeline-hard",
	title: "Anomaly Detection",
	description:
		"Given an array of sensor readings with fields: timestamp, sensor_id, reading, unit. " +
		"Group by sensor_id, compute the mean and standard deviation (population) of reading per sensor, " +
		"flag any reading that is more than 2 standard deviations from the mean, " +
		"and output only the flagged readings with additional fields: mean, stddev, z_score (absolute value). " +
		"Round mean, stddev, and z_score to 2 decimal places.",
	inputData: sensorInput,
	transformRules: [
		"Group by sensor_id",
		"Compute the mean and standard deviation of reading per sensor",
		"Flag any reading that is more than 2 standard deviations from the mean",
		"Output only the flagged readings with additional fields: mean, stddev, z_score",
	],
	expectedOutput: hardExpected,
	difficulty: "hard",
	tolerance: 0.05,
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const PIPELINE_PROBLEMS: PipelineProblem[] = [easyProblem, mediumProblem, hardProblem];

export function getProblemById(id: string): PipelineProblem | undefined {
	return PIPELINE_PROBLEMS.find((p) => p.id === id);
}
