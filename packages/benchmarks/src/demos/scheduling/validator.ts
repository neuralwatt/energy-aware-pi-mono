/**
 * Pure, deterministic validator for conference scheduling solutions.
 */

import type { Schedule, SchedulingProblem } from "./types.js";

/** Re-declared here to avoid build-order dependency on @neuralwatt/pi-task-agent. */
export interface ValidationResult {
	passed: boolean;
	score?: number;
	violations: string[];
	details?: unknown;
}

/**
 * Validate a schedule against the problem constraints.
 *
 * Checks (in order):
 * 1. Completeness -- every talk assigned exactly once
 * 2. No room double-booking
 * 3. No speaker conflicts (same speaker, same time slot)
 * 4. Capacity constraints
 * 5. Equipment requirements
 * 6. Sequence constraints
 * 7. Time preferences (soft -- affects score, not pass/fail)
 */
export function validateSchedule(problem: SchedulingProblem, schedule: Schedule): ValidationResult {
	const violations: string[] = [];
	let hardTotal = 0;
	let hardSatisfied = 0;
	let softTotal = 0;
	let softSatisfied = 0;

	// Build lookup maps
	const talkMap = new Map(problem.talks.map((t) => [t.id, t]));
	const roomMap = new Map(problem.rooms.map((r) => [r.id, r]));
	const slotMap = new Map(problem.time_slots.map((s) => [s.id, s]));
	const assignmentByTalk = new Map<string, (typeof schedule.assignments)[number]>();

	// -----------------------------------------------------------------------
	// 1. Completeness: every talk assigned exactly once
	// -----------------------------------------------------------------------
	const talkAssignCounts = new Map<string, number>();
	for (const a of schedule.assignments) {
		talkAssignCounts.set(a.talk_id, (talkAssignCounts.get(a.talk_id) ?? 0) + 1);
		assignmentByTalk.set(a.talk_id, a);
	}

	for (const talk of problem.talks) {
		hardTotal++;
		const count = talkAssignCounts.get(talk.id) ?? 0;
		if (count === 0) {
			violations.push(`Talk "${talk.title}" (${talk.id}) is not assigned to any slot`);
		} else if (count > 1) {
			violations.push(`Talk "${talk.title}" (${talk.id}) is assigned ${count} times`);
		} else {
			hardSatisfied++;
		}
	}

	// -----------------------------------------------------------------------
	// 2. No room double-booking: no two talks in same room at same time
	// -----------------------------------------------------------------------
	const roomSlotKeys = new Map<string, string>();
	for (const a of schedule.assignments) {
		const key = `${a.room_id}::${a.time_slot_id}`;
		hardTotal++;
		if (roomSlotKeys.has(key)) {
			const existingTalkId = roomSlotKeys.get(key)!;
			const existingTalk = talkMap.get(existingTalkId);
			const currentTalk = talkMap.get(a.talk_id);
			violations.push(
				`Room double-booking: "${currentTalk?.title ?? a.talk_id}" and "${existingTalk?.title ?? existingTalkId}" both in room ${a.room_id} at slot ${a.time_slot_id}`,
			);
		} else {
			roomSlotKeys.set(key, a.talk_id);
			hardSatisfied++;
		}
	}

	// -----------------------------------------------------------------------
	// 3. No speaker conflicts: speaker not in two places at once
	// -----------------------------------------------------------------------
	const speakerSlotMap = new Map<string, string[]>();
	for (const a of schedule.assignments) {
		const talk = talkMap.get(a.talk_id);
		if (!talk) continue;
		const key = `${talk.speaker_id}::${a.time_slot_id}`;
		const existing = speakerSlotMap.get(key) ?? [];
		existing.push(a.talk_id);
		speakerSlotMap.set(key, existing);
	}

	for (const [key, talkIds] of speakerSlotMap) {
		hardTotal++;
		if (talkIds.length > 1) {
			const [speakerId, slotId] = key.split("::");
			violations.push(
				`Speaker conflict: speaker ${speakerId} has ${talkIds.length} talks in slot ${slotId}: ${talkIds.join(", ")}`,
			);
		} else {
			hardSatisfied++;
		}
	}

	// -----------------------------------------------------------------------
	// 4-7. Process explicit constraints
	// -----------------------------------------------------------------------
	for (const constraint of problem.constraints) {
		switch (constraint.type) {
			case "capacity": {
				hardTotal++;
				const assignment = assignmentByTalk.get(constraint.talk_id);
				if (assignment) {
					const room = roomMap.get(assignment.room_id);
					if (room && constraint.expected_attendees > room.capacity) {
						violations.push(
							`Capacity violation: talk ${constraint.talk_id} expects ${constraint.expected_attendees} attendees but room ${room.name} (${room.id}) only holds ${room.capacity}`,
						);
					} else {
						hardSatisfied++;
					}
				} else {
					// Talk not assigned -- already caught in completeness check
					hardSatisfied++; // Don't double-penalise
				}
				break;
			}

			case "room_requirement": {
				hardTotal++;
				const assignment = assignmentByTalk.get(constraint.talk_id);
				if (assignment) {
					const room = roomMap.get(assignment.room_id);
					if (room) {
						const missing = constraint.equipment.filter((eq) => !room.equipment.includes(eq));
						if (missing.length > 0) {
							violations.push(
								`Equipment violation: talk ${constraint.talk_id} requires [${constraint.equipment.join(", ")}] but room ${room.name} (${room.id}) is missing [${missing.join(", ")}]`,
							);
						} else {
							hardSatisfied++;
						}
					} else {
						hardSatisfied++;
					}
				} else {
					hardSatisfied++;
				}
				break;
			}

			case "sequence": {
				hardTotal++;
				const firstAssignment = assignmentByTalk.get(constraint.first_talk_id);
				const thenAssignment = assignmentByTalk.get(constraint.then_talk_id);
				if (firstAssignment && thenAssignment) {
					const firstSlot = slotMap.get(firstAssignment.time_slot_id);
					const thenSlot = slotMap.get(thenAssignment.time_slot_id);
					if (firstSlot && thenSlot && firstSlot.start >= thenSlot.start) {
						violations.push(
							`Sequence violation: "${constraint.first_talk_id}" must come before "${constraint.then_talk_id}" but slot ${firstAssignment.time_slot_id} (${firstSlot.start}) is not before slot ${thenAssignment.time_slot_id} (${thenSlot.start})`,
						);
					} else {
						hardSatisfied++;
					}
				} else {
					hardSatisfied++;
				}
				break;
			}

			case "no_overlap": {
				// All listed talks must be in different time slots
				const slots = new Map<string, string>();
				for (const talkId of constraint.talk_ids) {
					hardTotal++;
					const assignment = assignmentByTalk.get(talkId);
					if (assignment) {
						if (slots.has(assignment.time_slot_id)) {
							violations.push(
								`No-overlap violation: talks ${slots.get(assignment.time_slot_id)} and ${talkId} are both in slot ${assignment.time_slot_id}`,
							);
						} else {
							slots.set(assignment.time_slot_id, talkId);
							hardSatisfied++;
						}
					} else {
						hardSatisfied++;
					}
				}
				break;
			}

			case "speaker_conflict": {
				// This is informational -- actual speaker conflicts are caught in step 3.
				// We don't add extra hard constraints here to avoid double-counting.
				break;
			}

			case "time_preference": {
				softTotal++;
				const assignment = assignmentByTalk.get(constraint.talk_id);
				if (assignment && constraint.preferred_slots.includes(assignment.time_slot_id)) {
					softSatisfied++;
				}
				break;
			}
		}
	}

	// -----------------------------------------------------------------------
	// Compute final score
	// -----------------------------------------------------------------------
	const passed = violations.length === 0;

	let score: number;
	if (hardTotal === 0) {
		score = softTotal === 0 ? 1 : softSatisfied / softTotal;
	} else if (softTotal === 0) {
		score = hardSatisfied / hardTotal;
	} else {
		score = (hardSatisfied / hardTotal) * 0.8 + (softSatisfied / softTotal) * 0.2;
	}

	// Round to avoid floating point noise
	score = Math.round(score * 1000) / 1000;

	return { passed, score, violations };
}
