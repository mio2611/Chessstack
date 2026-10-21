// DELETE /api/moves/[id] — remove a move and the lines that only it led to.
//
// A repertoire is a graph, not a tree: transpositions let several paths reach
// the same position, and a line can come back to an earlier position. So we do
// not delete "everything below the move". We remove the move, then every move
// that can no longer be reached from the root of the repertoire (see
// $lib/moveOrphans). Lines that are also reachable another way are kept, and
// loops cannot make the walk run forever.
//
// Example tree:
//   Start → e4 → e5 → Nf3 → Nc6
//                    → d4         ← a second branch
//
// Deleting "e5" deletes the entire subtree: Nf3, Nc6, and d4.
// Deleting "Nf3" only deletes Nf3 and Nc6 — the "e4 → e5 → d4" branch survives.
// If Nc6's position can also be reached through another opening move order,
// deleting Nf3 keeps it, and everything below it.
//
// This also cleans up the corresponding user_repertoire_move (SR card) rows,
// so deleted moves do not keep appearing in drill sessions. Everything runs in
// one transaction: it all happens or nothing does.
//
// Response: { deleted: number, deletedIds: number[] } — the client removes
// exactly these moves from its own copy.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { userMove, userRepertoireMove, repertoire } from '$lib/db/schema';
import { eq, and, inArray, notExists, sql } from 'drizzle-orm';
import { findOrphanedMoveIds, treeRoots } from '$lib/moveOrphans';

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	const id = parseInt(params.id);
	if (isNaN(id)) throw error(400, 'Invalid move ID');

	// Fetch the move — must exist and belong to this user.
	const [move] = await db
		.select()
		.from(userMove)
		.where(and(eq(userMove.id, id), eq(userMove.userId, userId)));

	if (!move) throw error(404, 'Move not found');

	const deletedIds = await db.transaction(async (tx) => {
		const [rep] = await tx
			.select({ startFen: repertoire.startFen })
			.from(repertoire)
			.where(and(eq(repertoire.id, move.repertoireId), eq(repertoire.userId, userId)));

		const rows = await tx
			.select({
				id: userMove.id,
				fromFen: userMove.fromFen,
				toFen: userMove.toFen,
				san: userMove.san
			})
			.from(userMove)
			.where(eq(userMove.repertoireId, move.repertoireId));

		// The tree as it will be once this move is gone, and what that cuts off.
		const after = rows.filter((r) => r.id !== move.id);
		const orphanIds = new Set(
			findOrphanedMoveIds(rows, after, treeRoots(rep?.startFen ?? null, move.fromFen))
		);
		const doomed = rows.filter((r) => r.id === move.id || orphanIds.has(r.id));

		// Delete the SR card of each removed move.
		// (Only user-turn moves have SR cards, but a no-op delete is harmless.)
		for (const m of doomed) {
			await tx
				.delete(userRepertoireMove)
				.where(
					and(
						eq(userRepertoireMove.userId, userId),
						eq(userRepertoireMove.repertoireId, move.repertoireId),
						eq(userRepertoireMove.fromFen, m.fromFen),
						eq(userRepertoireMove.san, m.san)
					)
				);
		}

		const ids = doomed.map((m) => m.id);
		await tx.delete(userMove).where(inArray(userMove.id, ids));

		// Defense-in-depth: sweep for orphaned SR cards in this repertoire.
		// An SR card is orphaned if no userMove exists with the same
		// (repertoireId, fromFen, san). This catches edge cases like FEN
		// normalization mismatches from PGN transpositions.
		// Uses a single NOT EXISTS subquery instead of per-card lookups.
		const orphanedCards = await tx
			.select({ id: userRepertoireMove.id })
			.from(userRepertoireMove)
			.where(
				and(
					eq(userRepertoireMove.userId, userId),
					eq(userRepertoireMove.repertoireId, move.repertoireId),
					notExists(
						tx
							.select({ one: sql`1` })
							.from(userMove)
							.where(
								and(
									eq(userMove.repertoireId, userRepertoireMove.repertoireId),
									eq(userMove.fromFen, userRepertoireMove.fromFen),
									eq(userMove.san, userRepertoireMove.san)
								)
							)
					)
				)
			);

		for (const card of orphanedCards) {
			await tx.delete(userRepertoireMove).where(eq(userRepertoireMove.id, card.id));
		}

		return ids;
	});

	return json({ deleted: deletedIds.length, deletedIds });
};

// ── PATCH ──────────────────────────────────────────────────────────────────────
// Updates the notes annotation on a single move.
// Expects JSON body: { notes: string | null }
// An empty string is coerced to null — we do not store empty annotations.

export const PATCH: RequestHandler = async ({ locals, request, params }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = parseInt(params.id);
	if (isNaN(id)) throw error(400, 'Invalid move ID');

	// Ownership check — one query, fails for wrong user or missing row.
	const [move] = await db
		.select()
		.from(userMove)
		.where(and(eq(userMove.id, id), eq(userMove.userId, locals.user.id)));

	if (!move) throw error(404, 'Move not found');

	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	let { notes } = body;

	if (notes !== null && typeof notes !== 'string') {
		throw error(400, 'notes must be a string or null');
	}
	if (typeof notes === 'string') {
		notes = notes.trim();
		if (notes.length === 0) notes = null;
		if (notes !== null && notes.length > 500) {
			throw error(400, 'notes must be 500 characters or fewer');
		}
	}

	const [updated] = await db.update(userMove).set({ notes }).where(eq(userMove.id, id)).returning();

	return json(updated);
};
