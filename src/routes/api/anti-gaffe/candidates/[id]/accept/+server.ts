// POST /api/anti-gaffe/candidates/[id]/accept
//
// Accepts a pending candidate: attaches it to the FSRS card for its
// position (one card per (user, fen) — never per candidate, see
// anti_gaffe_card's own comment in schema.ts), creating that card if it
// doesn't exist yet.
//
// If a card already exists for this FEN with a DIFFERENT confirmed move,
// this mirrors /api/review/add-move's conflict handling exactly: returns
// 409 with the existing card rather than silently overwriting, unless the
// caller passes forceReplace: true.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { antiGaffeCandidate, antiGaffeCard } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	const candidateId = parseInt(params.id ?? '');
	if (isNaN(candidateId)) throw error(400, 'Invalid candidate id');

	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	const { confirmedMoveSan, forceReplace = false } = body;
	if (!confirmedMoveSan || typeof confirmedMoveSan !== 'string') {
		throw error(400, 'confirmedMoveSan is required');
	}

	const [candidate] = await db
		.select()
		.from(antiGaffeCandidate)
		.where(and(eq(antiGaffeCandidate.id, candidateId), eq(antiGaffeCandidate.userId, userId)));

	if (!candidate) throw error(404, 'Candidate not found');
	if (candidate.status !== 'pending') {
		throw error(409, `Candidate already ${candidate.status}`);
	}

	const [existingCard] = await db
		.select()
		.from(antiGaffeCard)
		.where(and(eq(antiGaffeCard.userId, userId), eq(antiGaffeCard.fen, candidate.fen)));

	if (existingCard && existingCard.confirmedMoveSan !== confirmedMoveSan && !forceReplace) {
		return json(
			{
				error: 'A card for this position already expects a different move',
				existing: existingCard
			},
			{ status: 409 }
		);
	}

	const updatedCandidate = await db.transaction(async (tx) => {
		let cardId: number;

		if (existingCard) {
			cardId = existingCard.id;
			if (forceReplace && confirmedMoveSan !== existingCard.confirmedMoveSan) {
				await tx
					.update(antiGaffeCard)
					.set({ confirmedMoveSan })
					.where(eq(antiGaffeCard.id, existingCard.id));
			}
		} else {
			const [newCard] = await tx
				.insert(antiGaffeCard)
				.values({
					userId,
					fen: candidate.fen,
					confirmedMoveSan,
					due: new Date(),
					state: 0, // New
					reps: 0,
					lapses: 0,
					stability: null,
					difficulty: null,
					elapsedDays: null,
					scheduledDays: null,
					lastReview: null,
					learningSteps: 0
				})
				.returning();
			cardId = newCard.id;
		}

		const [updated] = await tx
			.update(antiGaffeCandidate)
			.set({
				status: 'accepted',
				confirmedMoveSan,
				cardId,
				reviewedAt: new Date()
			})
			.where(eq(antiGaffeCandidate.id, candidateId))
			.returning();

		return updated;
	});

	return json(updatedCandidate);
};
