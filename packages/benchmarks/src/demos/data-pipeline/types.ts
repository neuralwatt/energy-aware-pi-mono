export interface PipelineProblem {
	id: string;
	title: string;
	description: string;
	inputData: unknown[];
	transformRules: string[];
	expectedOutput: unknown[];
	difficulty: "easy" | "medium" | "hard";
	tolerance?: number;
}
