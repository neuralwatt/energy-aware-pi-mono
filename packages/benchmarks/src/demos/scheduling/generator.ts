/**
 * Deterministic problem generator for conference scheduling benchmarks.
 */

import type { Constraint, Room, SchedulingProblem, Talk, TimeSlot } from "./types.js";

// ---------------------------------------------------------------------------
// Fixed data pools (deterministic, index-based selection)
// ---------------------------------------------------------------------------

const TALK_TITLES = [
	"Introduction to GraphQL",
	"Advanced Kubernetes Patterns",
	"Building Resilient Microservices",
	"Machine Learning in Production",
	"React Server Components Deep Dive",
	"Zero-Trust Security Architecture",
	"Event-Driven Architecture with Kafka",
	"Scaling PostgreSQL for High Traffic",
	"WebAssembly Beyond the Browser",
	"Designing Accessible Web Applications",
	"Real-Time Data Pipelines with Flink",
	"Terraform at Scale",
	"gRPC vs REST: A Practical Comparison",
	"Observability with OpenTelemetry",
	"Type-Safe APIs with tRPC",
	"Functional Programming in TypeScript",
	"Container Security Best Practices",
	"Edge Computing with Cloudflare Workers",
	"Database Sharding Strategies",
	"CI/CD Pipeline Optimization",
	"Rust for Systems Programming",
	"GraphQL Federation Patterns",
	"Distributed Tracing in Practice",
	"Building Design Systems at Scale",
	"Serverless Architecture Pitfalls",
	"Performance Tuning Node.js Applications",
	"Data Mesh Architecture",
	"API Gateway Design Patterns",
	"Chaos Engineering Fundamentals",
	"Progressive Web Apps in 2025",
	"Stream Processing with Apache Pulsar",
	"Infrastructure as Code with Pulumi",
	"Micro-Frontends Architecture",
	"MLOps Pipeline Design",
	"WebSocket Scaling Strategies",
	"Domain-Driven Design in Practice",
	"Cloud Cost Optimization",
	"Service Mesh with Istio",
	"Real-Time Collaboration Systems",
	"CQRS and Event Sourcing",
	"Browser Rendering Performance",
	"Kubernetes Operator Patterns",
	"Data Lake Architecture",
	"API Versioning Strategies",
	"Load Testing with k6",
	"Feature Flag Architecture",
	"Multi-Tenant SaaS Design",
	"Async Rust Patterns",
	"Full-Text Search with Elasticsearch",
	"Platform Engineering Practices",
];

const SPEAKER_NAMES = [
	"Alice Chen",
	"Bob Martinez",
	"Carol Williams",
	"David Kim",
	"Elena Petrov",
	"Frank Johnson",
	"Grace Liu",
	"Henry Taylor",
	"Iris Nakamura",
	"James Wilson",
	"Karen Singh",
	"Leo Hernandez",
	"Maria Costa",
	"Nathan Park",
	"Olivia Brown",
	"Patrick O'Brien",
	"Quinn Davis",
	"Rachel Lee",
	"Samuel Torres",
	"Tina Muller",
	"Ulrich Wagner",
	"Victoria Adams",
	"William Chang",
	"Xena Robinson",
	"Yuri Volkov",
];

const ROOM_NAMES = [
	"Main Hall",
	"Workshop Room A",
	"Workshop Room B",
	"Auditorium",
	"Lab 1",
	"Lab 2",
	"Conference Room C",
	"Innovation Hub",
	"Summit Room",
	"Breakout Room D",
];

const TRACKS = ["frontend", "backend", "devops", "data", "security"];

const EQUIPMENT_OPTIONS = ["projector", "whiteboard", "microphone", "video_recording", "live_streaming"];

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function makeTalks(count: number): Talk[] {
	const talks: Talk[] = [];
	for (let i = 0; i < count; i++) {
		talks.push({
			id: `talk-${i + 1}`,
			title: TALK_TITLES[i % TALK_TITLES.length],
			speaker_id: `speaker-${(i % SPEAKER_NAMES.length) + 1}`,
			duration_minutes: [30, 45, 60][i % 3],
			track: TRACKS[i % TRACKS.length],
		});
	}
	return talks;
}

function makeRooms(count: number): Room[] {
	const rooms: Room[] = [];
	const capacities = [50, 100, 200, 300, 150, 80, 120, 250, 400, 60];
	for (let i = 0; i < count; i++) {
		const equipmentCount = (i % 3) + 1;
		const equipment: string[] = [];
		for (let e = 0; e < equipmentCount; e++) {
			equipment.push(EQUIPMENT_OPTIONS[(i + e) % EQUIPMENT_OPTIONS.length]);
		}
		rooms.push({
			id: `room-${i + 1}`,
			name: ROOM_NAMES[i % ROOM_NAMES.length],
			capacity: capacities[i % capacities.length],
			equipment,
		});
	}
	return rooms;
}

function makeTimeSlots(count: number): TimeSlot[] {
	const slots: TimeSlot[] = [];
	const baseHour = 9;
	for (let i = 0; i < count; i++) {
		const hour = baseHour + i;
		const startH = String(hour).padStart(2, "0");
		const endH = String(hour + 1).padStart(2, "0");
		slots.push({
			id: `slot-${i + 1}`,
			start: `${startH}:00`,
			end: `${endH}:00`,
		});
	}
	return slots;
}

function makeConstraints(talks: Talk[], _rooms: Room[], timeSlots: TimeSlot[], targetCount: number): Constraint[] {
	const constraints: Constraint[] = [];

	// Speaker conflicts: find speakers with multiple talks
	const speakerTalks = new Map<string, string[]>();
	for (const t of talks) {
		const list = speakerTalks.get(t.speaker_id) ?? [];
		list.push(t.id);
		speakerTalks.set(t.speaker_id, list);
	}

	for (const [speakerId, talkIds] of speakerTalks) {
		if (talkIds.length > 1 && constraints.length < targetCount) {
			constraints.push({
				type: "speaker_conflict",
				speaker_id: speakerId,
				description: `Speaker ${speakerId} has ${talkIds.length} talks and cannot be in two places at once`,
			});
		}
	}

	// Room requirements
	for (let i = 0; i < talks.length && constraints.length < targetCount; i += 3) {
		const eqIdx = (i / 3) % EQUIPMENT_OPTIONS.length;
		constraints.push({
			type: "room_requirement",
			talk_id: talks[i].id,
			equipment: [EQUIPMENT_OPTIONS[eqIdx]],
		});
	}

	// Capacity constraints
	for (let i = 1; i < talks.length && constraints.length < targetCount; i += 4) {
		constraints.push({
			type: "capacity",
			talk_id: talks[i].id,
			expected_attendees: [40, 80, 150, 250][i % 4],
		});
	}

	// Sequence constraints
	for (let i = 0; i + 1 < talks.length && constraints.length < targetCount; i += 5) {
		constraints.push({
			type: "sequence",
			first_talk_id: talks[i].id,
			then_talk_id: talks[i + 1].id,
		});
	}

	// No-overlap constraints
	for (let i = 0; i + 2 < talks.length && constraints.length < targetCount; i += 7) {
		constraints.push({
			type: "no_overlap",
			talk_ids: [talks[i].id, talks[i + 1].id, talks[i + 2].id],
		});
	}

	// Time preferences (soft)
	for (let i = 2; i < talks.length && constraints.length < targetCount; i += 4) {
		const prefSlots = [timeSlots[i % timeSlots.length].id];
		if (timeSlots.length > 1) {
			prefSlots.push(timeSlots[(i + 1) % timeSlots.length].id);
		}
		constraints.push({
			type: "time_preference",
			talk_id: talks[i].id,
			preferred_slots: prefSlots,
		});
	}

	return constraints;
}

function buildDescription(talks: Talk[], rooms: Room[], timeSlots: TimeSlot[], constraints: Constraint[]): string {
	const hardConstraints = constraints.filter((c) => c.type !== "time_preference");
	const softConstraints = constraints.filter((c) => c.type === "time_preference");

	return [
		`Schedule ${talks.length} conference talks across ${rooms.length} rooms and ${timeSlots.length} time slots.`,
		`Time slots run from ${timeSlots[0].start} to ${timeSlots[timeSlots.length - 1].end}.`,
		`There are ${hardConstraints.length} hard constraints and ${softConstraints.length} soft preferences.`,
		"Each talk must be assigned exactly one room and time slot.",
		"No room can host two talks at the same time.",
		"No speaker can give two talks at the same time.",
	].join(" ");
}

/**
 * Generate a deterministic scheduling problem of the given difficulty.
 */
export function generateProblem(difficulty: "small" | "medium" | "hard"): SchedulingProblem {
	const config = {
		small: { talks: 5, rooms: 2, slots: 4, constraints: 3 },
		medium: { talks: 20, rooms: 5, slots: 8, constraints: 15 },
		hard: { talks: 50, rooms: 10, slots: 12, constraints: 40 },
	}[difficulty];

	const talks = makeTalks(config.talks);
	const rooms = makeRooms(config.rooms);
	const time_slots = makeTimeSlots(config.slots);
	const constraints = makeConstraints(talks, rooms, time_slots, config.constraints);

	return {
		talks,
		rooms,
		time_slots,
		constraints,
		description: buildDescription(talks, rooms, time_slots, constraints),
	};
}
