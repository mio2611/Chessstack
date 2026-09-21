// POST /api/anti-gaffe/candidates/[id]/undo
//
// Reverts an accepted or rejected candidate back to pending — for the
// "clicked the wrong button" case, which had no way back before this.
//
// Rejected → pending is trivial (reject never touched anything else).
//
// Accepted → pending detaches the candidate from its card (card_id, status,
// confirmed_move_san all cleared). If that card is now referenced by no
// other candidate AND has no FSRS review history (anti_gaffe_review_log),
// it's deleted too — it only ever existed because of this one accept, so
// undoing it should leave no orphaned card behind. If the card is shared
// with other candidates, or has already been drilled, it's left alone:
// only this candidate detaches from it.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { antiGaffeCandidate, antiGaffeCard, antiGaffeReviewLog } from '$lib/db/schema';
import { eq, and, count } from 'drizzle-orm';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	const candidateId = parseInt(params.id ?? '');
	if (isNaN(candidateId)) throw error(400, 'Invalid candidate id');

	const [candidate] = await db
		.select()
		.from(antiGaffeCandidate)
		.where(and(eq(antiGaffeCandidate.id, candidateId), eq(antiGaffeCandidate.userId, userId)));

	if (!candidate) throw error(404, 'Candidate not found');
	if (candidate.status === 'pending') {
		throw error(409, 'Candidate is already pending');
	}

	const cardIdToCheck = candidate.cardId;

	const updated = await db.transaction(async (tx) => {
		const [reverted] = await tx
			.update(antiGaffeCandidate)
			.set({
				status: 'pending',
				cardId: null,
				confirmedMoveSan: null,
				reviewedAt: null
			})
			.where(eq(antiGaffeCandidate.id, candidateId))
			.returning();

		if (cardIdToCheck !== null) {
			const [{ value: otherCandidates }] = await tx
				.select({ value: count() })
				.from(antiGaffeCandidate)
				.where(eq(antiGaffeCandidate.cardId, cardIdToCheck));
			const [{ value: reviewLogEntries }] = await tx
				.select({ value: count() })
				.from(antiGaffeReviewLog)
				.where(eq(antiGaffeReviewLog.cardId, cardIdToCheck));

			if (otherCandidates === 0 && reviewLogEntries === 0) {
				await tx.delete(antiGaffeCard).where(eq(antiGaffeCard.id, cardIdToCheck));
			}
		}

		return reverted;
	});

	return json(updated);
};
