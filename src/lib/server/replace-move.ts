// Replacing the user's move at a position by a different move.
//
// Used by PGN import, "add to repertoire" from a prep, and the game review's
// "replace" action, so the three behave the same:
//
// - the move gets a fresh drill card. The old card's FSRS state (stability,
//   reps, lapses...) describes the memory of a different move; keeping it would
//   have the new move scheduled as if it were already learned. The old card and
//   its review history go with it, like when a move is deleted.
// - the old note is replaced by the new one (null when there is none): it
//   described the old move.
// - the lines that only the old move led to are removed, with their cards.
//   Lines reachable another way (a transposition) are kept. Decided by
//   reachability, see $lib/moveOrphans, so loops cannot make it run forever.

import { db } from '$lib/db';
import { userMove, userRepertoireMove } from '$lib/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { findOrphanedMoveIds, treeRoots } from '$lib/moveOrphans';

// Transaction type extracted from db.transaction() callback parameter
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface MoveReplacement {
	/** id of the stored move being replaced (updated in place). */
	moveId: number;
	/** Position the move is played from (4-field FEN key). */
	fromFen: string;
	oldSan: string;
	newSan: string;
	/** Position after the new move, computed server-side (4-field FEN key). */
	newToFen: string;
	source: string;
	/** Note for the new move, or null. */
	notes: string | null;
	/** The repertoire's custom start position, if it has one. */
	startFen: string | null;
	now: Date;
}

/** Replace a user-turn move. Must run inside a transaction. */
export async function replaceUserMove(
	tx: Transaction,
	userId: number,
	repertoireId: number,
	r: MoveReplacement
): Promise<void> {
	const rows = await tx
		.select({
			id: userMove.id,
			fromFen: userMove.fromFen,
			toFen: userMove.toFen,
			san: userMove.san
		})
		.from(userMove)
		.where(eq(userMove.repertoireId, repertoireId));

	// The tree as it will stand once the move is replaced, and what that cuts off.
	const after = rows.map((m) =>
		m.id === r.moveId ? { ...m, san: r.newSan, toFen: r.newToFen } : m
	);
	const orphanIds = new Set(findOrphanedMoveIds(rows, after, treeRoots(r.startFen, r.fromFen)));
	const orphans = rows.filter((m) => orphanIds.has(m.id));

	// Remove the cards of the orphaned moves, then the moves themselves.
	for (const m of orphans) {
		await tx
			.delete(userRepertoireMove)
			.where(
				and(
					eq(userRepertoireMove.userId, userId),
					eq(userRepertoireMove.repertoireId, repertoireId),
					eq(userRepertoireMove.fromFen, m.fromFen),
					eq(userRepertoireMove.san, m.san)
				)
			);
	}
	if (orphans.length > 0) {
		await tx.delete(userMove).where(
			inArray(
				userMove.id,
				orphans.map((m) => m.id)
			)
		);
	}

	// Drop the old move's card (its review log goes with it).
	await tx
		.delete(userRepertoireMove)
		.where(
			and(
				eq(userRepertoireMove.userId, userId),
				eq(userRepertoireMove.repertoireId, repertoireId),
				eq(userRepertoireMove.fromFen, r.fromFen),
				eq(userRepertoireMove.san, r.oldSan)
			)
		);

	// The stored move becomes the new one.
	await tx
		.update(userMove)
		.set({
			san: r.newSan,
			toFen: r.newToFen,
			source: r.source,
			notes: r.notes,
			createdAt: r.now
		})
		.where(eq(userMove.id, r.moveId));

	// A brand-new card for the new move.
	await tx.insert(userRepertoireMove).values({
		userId,
		repertoireId,
		fromFen: r.fromFen,
		san: r.newSan,
		due: r.now,
		state: 0,
		reps: 0,
		lapses: 0,
		stability: null,
		difficulty: null,
		elapsedDays: null,
		scheduledDays: null,
		lastReview: null,
		learningSteps: 0
	});
}
