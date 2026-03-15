import { describe, expect, it } from "vitest";
import type { Constraint, Room, Schedule, SchedulingProblem, Talk, TimeSlot } from "../src/demos/scheduling/index.js";
import { generateProblem, validateSchedule } from "../src/demos/scheduling/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProblem(overrides?: Partial<SchedulingProblem>): SchedulingProblem {
	const talks: Talk[] = [
		{ id: "t1", title: "Talk One", speaker_id: "s1", duration_minutes: 30 },
		{ id: "t2", title: "Talk Two", speaker_id: "s2", duration_minutes: 45 },
		{ id: "t3", title: "Talk Three", speaker_id: "s3", duration_minutes: 60 },
	];
	const rooms: Room[] = [
		{ id: "r1", name: "Room A", capacity: 100, equipment: ["projector", "microphone"] },
		{ id: "r2", name: "Room B", capacity: 50, equipment: ["whiteboard"] },
	];
	const time_slots: TimeSlot[] = [
		{ id: "sl1", start: "09:00", end: "10:00" },
		{ id: "sl2", start: "10:00", end: "11:00" },
		{ id: "sl3", start: "11:00", end: "12:00" },
	];
	return {
		talks,
		rooms,
		time_slots,
		constraints: [],
		description: "Test scheduling problem",
		...overrides,
	};
}

function validSchedule(): Schedule {
	return {
		assignments: [
			{ talk_id: "t1", room_id: "r1", time_slot_id: "sl1" },
			{ talk_id: "t2", room_id: "r2", time_slot_id: "sl1" },
			{ talk_id: "t3", room_id: "r1", time_slot_id: "sl2" },
		],
	};
}

// ---------------------------------------------------------------------------
// Validator tests
// ---------------------------------------------------------------------------

describe("validateSchedule", () => {
	it("valid schedule passes", () => {
		const problem = makeProblem();
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(true);
		expect(result.violations).toHaveLength(0);
		expect(result.score).toBe(1);
	});

	it("missing talk assignment fails", () => {
		const problem = makeProblem();
		const schedule: Schedule = {
			assignments: [
				{ talk_id: "t1", room_id: "r1", time_slot_id: "sl1" },
				{ talk_id: "t2", room_id: "r2", time_slot_id: "sl1" },
				// t3 missing
			],
		};
		const result = validateSchedule(problem, schedule);
		expect(result.passed).toBe(false);
		expect(result.violations.some((v: string) => v.includes("t3"))).toBe(true);
	});

	it("duplicate talk assignment fails", () => {
		const problem = makeProblem();
		const schedule: Schedule = {
			assignments: [
				{ talk_id: "t1", room_id: "r1", time_slot_id: "sl1" },
				{ talk_id: "t1", room_id: "r2", time_slot_id: "sl2" },
				{ talk_id: "t2", room_id: "r2", time_slot_id: "sl1" },
				{ talk_id: "t3", room_id: "r1", time_slot_id: "sl2" },
			],
		};
		const result = validateSchedule(problem, schedule);
		expect(result.passed).toBe(false);
		expect(result.violations.some((v: string) => v.includes("assigned 2 times"))).toBe(true);
	});

	it("room double-booking detected", () => {
		const problem = makeProblem();
		const schedule: Schedule = {
			assignments: [
				{ talk_id: "t1", room_id: "r1", time_slot_id: "sl1" },
				{ talk_id: "t2", room_id: "r1", time_slot_id: "sl1" }, // same room, same slot
				{ talk_id: "t3", room_id: "r2", time_slot_id: "sl1" },
			],
		};
		const result = validateSchedule(problem, schedule);
		expect(result.passed).toBe(false);
		expect(result.violations.some((v: string) => v.includes("Room double-booking"))).toBe(true);
	});

	it("speaker conflict detected", () => {
		// Two talks by the same speaker
		const problem = makeProblem({
			talks: [
				{ id: "t1", title: "Talk One", speaker_id: "s1", duration_minutes: 30 },
				{ id: "t2", title: "Talk Two", speaker_id: "s1", duration_minutes: 45 },
				{ id: "t3", title: "Talk Three", speaker_id: "s3", duration_minutes: 60 },
			],
		});
		const schedule: Schedule = {
			assignments: [
				{ talk_id: "t1", room_id: "r1", time_slot_id: "sl1" },
				{ talk_id: "t2", room_id: "r2", time_slot_id: "sl1" }, // same speaker, same slot
				{ talk_id: "t3", room_id: "r1", time_slot_id: "sl2" },
			],
		};
		const result = validateSchedule(problem, schedule);
		expect(result.passed).toBe(false);
		expect(result.violations.some((v: string) => v.includes("Speaker conflict"))).toBe(true);
	});

	it("capacity violation detected", () => {
		const constraints: Constraint[] = [{ type: "capacity", talk_id: "t1", expected_attendees: 200 }];
		const problem = makeProblem({ constraints });
		// t1 assigned to r1 (capacity 100), expects 200
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(false);
		expect(result.violations.some((v: string) => v.includes("Capacity violation"))).toBe(true);
	});

	it("equipment requirement violation detected", () => {
		const constraints: Constraint[] = [{ type: "room_requirement", talk_id: "t2", equipment: ["projector"] }];
		const problem = makeProblem({ constraints });
		// t2 is assigned to r2 which only has "whiteboard", not "projector"
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(false);
		expect(result.violations.some((v: string) => v.includes("Equipment violation"))).toBe(true);
	});

	it("equipment requirement satisfied", () => {
		const constraints: Constraint[] = [{ type: "room_requirement", talk_id: "t1", equipment: ["projector"] }];
		const problem = makeProblem({ constraints });
		// t1 is assigned to r1 which has "projector"
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(true);
	});

	it("sequence constraint violation detected", () => {
		const constraints: Constraint[] = [{ type: "sequence", first_talk_id: "t3", then_talk_id: "t1" }];
		const problem = makeProblem({ constraints });
		// t3 is in sl2 (10:00), t1 is in sl1 (09:00) -- t3 should be before t1 but 10:00 >= 09:00 -- wait
		// Actually t3 is in sl2 start=10:00, t1 in sl1 start=09:00. Constraint says t3 first, t1 then.
		// firstSlot.start (10:00) >= thenSlot.start (09:00) => violation. Correct.
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(false);
		expect(result.violations.some((v: string) => v.includes("Sequence violation"))).toBe(true);
	});

	it("sequence constraint satisfied", () => {
		const constraints: Constraint[] = [{ type: "sequence", first_talk_id: "t1", then_talk_id: "t3" }];
		const problem = makeProblem({ constraints });
		// t1 in sl1 (09:00), t3 in sl2 (10:00) -- 09:00 < 10:00 => satisfied
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(true);
	});

	it("time preference affects score but not pass/fail", () => {
		const constraints: Constraint[] = [{ type: "time_preference", talk_id: "t1", preferred_slots: ["sl3"] }];
		const problem = makeProblem({ constraints });
		// t1 in sl1, preference is sl3 -- not matched
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(true); // soft constraint, still passes
		expect(result.score).toBeLessThan(1); // but score is reduced
	});

	it("time preference satisfied gives full score", () => {
		const constraints: Constraint[] = [{ type: "time_preference", talk_id: "t1", preferred_slots: ["sl1"] }];
		const problem = makeProblem({ constraints });
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(true);
		expect(result.score).toBe(1);
	});

	it("score calculation is correct with mixed constraints", () => {
		const constraints: Constraint[] = [
			// Hard: capacity OK (t1 expects 50, r1 has 100)
			{ type: "capacity", talk_id: "t1", expected_attendees: 50 },
			// Soft: preference NOT met (t2 in sl1, pref is sl3)
			{ type: "time_preference", talk_id: "t2", preferred_slots: ["sl3"] },
		];
		const problem = makeProblem({ constraints });
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(true);
		// hard: all satisfied (completeness 3/3, room booking 3/3, speaker 3/3, capacity 1/1)
		// = 10 hard total, 10 hard satisfied
		// soft: 0/1 satisfied
		// score = (10/10) * 0.8 + (0/1) * 0.2 = 0.8
		expect(result.score).toBe(0.8);
	});

	it("no-overlap constraint violation detected", () => {
		const constraints: Constraint[] = [{ type: "no_overlap", talk_ids: ["t1", "t2"] }];
		const problem = makeProblem({ constraints });
		// t1 and t2 are both in sl1 in our valid schedule
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(false);
		expect(result.violations.some((v: string) => v.includes("No-overlap violation"))).toBe(true);
	});

	it("no-overlap constraint satisfied", () => {
		const constraints: Constraint[] = [{ type: "no_overlap", talk_ids: ["t1", "t3"] }];
		const problem = makeProblem({ constraints });
		// t1 in sl1, t3 in sl2 -- different slots
		const result = validateSchedule(problem, validSchedule());
		expect(result.passed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Generator tests
// ---------------------------------------------------------------------------

describe("generateProblem", () => {
	it.each(["small", "medium", "hard"] as const)("produces valid structure for %s difficulty", (difficulty) => {
		const problem = generateProblem(difficulty);

		expect(problem.talks.length).toBeGreaterThan(0);
		expect(problem.rooms.length).toBeGreaterThan(0);
		expect(problem.time_slots.length).toBeGreaterThan(0);
		expect(problem.constraints.length).toBeGreaterThan(0);
		expect(problem.description).toBeTruthy();

		// Every talk has required fields
		for (const talk of problem.talks) {
			expect(talk.id).toBeTruthy();
			expect(talk.title).toBeTruthy();
			expect(talk.speaker_id).toBeTruthy();
			expect(talk.duration_minutes).toBeGreaterThan(0);
		}

		// Every room has required fields
		for (const room of problem.rooms) {
			expect(room.id).toBeTruthy();
			expect(room.name).toBeTruthy();
			expect(room.capacity).toBeGreaterThan(0);
			expect(Array.isArray(room.equipment)).toBe(true);
		}

		// Every time slot has required fields
		for (const slot of problem.time_slots) {
			expect(slot.id).toBeTruthy();
			expect(slot.start).toBeTruthy();
			expect(slot.end).toBeTruthy();
		}

		// Unique IDs
		const talkIds = problem.talks.map((t) => t.id);
		expect(new Set(talkIds).size).toBe(talkIds.length);

		const roomIds = problem.rooms.map((r) => r.id);
		expect(new Set(roomIds).size).toBe(roomIds.length);

		const slotIds = problem.time_slots.map((s) => s.id);
		expect(new Set(slotIds).size).toBe(slotIds.length);
	});

	it("small has expected counts", () => {
		const p = generateProblem("small");
		expect(p.talks).toHaveLength(5);
		expect(p.rooms).toHaveLength(2);
		expect(p.time_slots).toHaveLength(3);
	});

	it("medium has expected counts", () => {
		const p = generateProblem("medium");
		expect(p.talks).toHaveLength(15);
		expect(p.rooms).toHaveLength(4);
		expect(p.time_slots).toHaveLength(5);
	});

	it("hard has expected counts", () => {
		const p = generateProblem("hard");
		expect(p.talks).toHaveLength(30);
		expect(p.rooms).toHaveLength(5);
		expect(p.time_slots).toHaveLength(7);
	});

	it("is deterministic", () => {
		const a = generateProblem("medium");
		const b = generateProblem("medium");
		expect(a).toEqual(b);
	});
});
