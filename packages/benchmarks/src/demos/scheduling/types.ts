/**
 * Types for the conference scheduling benchmark problem.
 */

export interface Talk {
	id: string;
	title: string;
	speaker_id: string;
	duration_minutes: number;
	track?: string;
}

export interface Room {
	id: string;
	name: string;
	capacity: number;
	equipment: string[];
}

export interface TimeSlot {
	id: string;
	start: string;
	end: string;
}

export type Constraint =
	| { type: "speaker_conflict"; speaker_id: string; description: string }
	| { type: "room_requirement"; talk_id: string; equipment: string[] }
	| { type: "time_preference"; talk_id: string; preferred_slots: string[] }
	| { type: "sequence"; first_talk_id: string; then_talk_id: string }
	| { type: "no_overlap"; talk_ids: string[] }
	| { type: "capacity"; talk_id: string; expected_attendees: number };

export interface SchedulingProblem {
	talks: Talk[];
	rooms: Room[];
	time_slots: TimeSlot[];
	constraints: Constraint[];
	description: string;
}

export interface Assignment {
	talk_id: string;
	room_id: string;
	time_slot_id: string;
}

export interface Schedule {
	assignments: Assignment[];
}
