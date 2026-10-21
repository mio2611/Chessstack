// POST /api/review/add-move
//
// Add a move to the user's repertoire from the game review page.
// Called for:
//   Case 2 (BEYOND_REPERTOIRE): user wants to add the move they played, or the
//     engine's suggestion, at a position they haven't mapped yet.
//   Case 3 (OPPONENT_SURPRISE): user wants to add the opponent's surprise move
//     and/or their own response to it.
//
// The optional `forceReplace` flag handles Case 1 (DEVIATION): when true, if a
// *different* move already exists from this position, update it rather than
// returning a 409 conflict. The move gets a fresh drill card (the old card's
// FSRS state belonged to a different move), its note is cleared, and the lines
// that only the old move led to are removed (lines also reachable another way,
// through a transposition, are kept).
//
// Core logic mirrors POST /api/moves to keep behaviour consistent.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Chess } from 'chess.js';
import { db } from '$lib/db';
import { repertoire, userMove, userRepertoireMove } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { fenKey } from '$lib/fen';
import { replaceUserMove } from '$lib/server/replace-move';
import { lockRepertoire } from '$lib/server/repertoire-lock';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const user = locals.user;

	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	const { repertoireId, san, forceReplace = false } = body;

	if (typeof repertoireId !== 'number') throw error(400, 'repertoireId must be a number');
	if (!body.fromFen || typeof body.fromFen !== 'string') throw error(400, 'fromFen is required');
	if (body.fromFen.length > 100) throw error(400, 'fromFen is too long');

	// Normalize to 4-field FEN so transpositions always match.
	const fromFen = fenKey(body.fromFen);
	if (!san || typeof san !== 'string') throw error(400, 'san is required');

	// Verify the repertoire belongs to this user.
	const [rep] = await db
		.select()
		.from(repertoire)
		.where(and(eq(repertoire.id, repertoireId), eq(repertoire.userId, user.id)));
	if (!rep) throw error(404, 'Repertoire not found');

	// Compute toFen server-side (never accepted from the client — prevents crafted
	// requests from corrupting the move tree with arbitrary FENs).
	let isUserTurn: boolean;
	let toFen: string;
	try {
		const chess = new Chess(fromFen);
		const fenTurn = chess.turn(); // 'w' or 'b'
		isUserTurn =
			(rep.color === 'WHITE' && fenTurn === 'w') || (rep.color === 'BLACK' && fenTurn === 'b');
		const result = chess.move(san);
		if (!result) throw new Error('Illegal move');
		toFen = fenKey(chess.fen());
	} catch {
		throw error(400, 'Invalid FEN or illegal move');
	}

	// Check, then write, inside one transaction that first locks the repertoire:
	// two simultaneous requests would otherwise both find nothing and both insert.
	// The new move and (for the user's own moves) its SR card, or a replacement,
	// succeed or roll back together. Opponent moves are not drilled.
	const outcome = await db.transaction(async (tx) => {
		if (!(await lockRepertoire(tx, repertoireId))) return { kind: 'gone' } as const;

		if (isUserTurn) {
			const [existing] = await tx
				.select()
				.from(userMove)
				.where(and(eq(userMove.repertoireId, repertoireId), eq(userMove.fromFen, fromFen)));

			if (existing) {
				// Exact same move already exists: idempotent.
				if (existing.san === san) return { kind: 'existing', move: existing } as const;

				// Different move exists and we're not replacing: signal conflict.
				if (!forceReplace) return { kind: 'conflict', existing } as const;

				// forceReplace: the user's move at this position changes.
				await replaceUserMove(tx, user.id, repertoireId, {
					moveId: existing.id,
					fromFen,
					oldSan: existing.san,
					newSan: san,
					newToFen: toFen,
					source: 'PERSONAL',
					notes: null,
					startFen: rep.startFen,
					now: new Date()
				});
				const [updated] = await tx.select().from(userMove).where(eq(userMove.id, existing.id));
				return { kind: 'replaced', move: updated } as const;
			}
		} else {
			// Opponent's turn: multiple moves allowed, but no exact duplicates.
			const [existing] = await tx
				.select()
				.from(userMove)
				.where(
					and(
						eq(userMove.repertoireId, repertoireId),
						eq(userMove.fromFen, fromFen),
						eq(userMove.san, san)
					)
				);

			if (existing) return { kind: 'existing', move: existing } as const;
		}

		const [move] = await tx
			.insert(userMove)
			.values({
				userId: user.id,
				repertoireId,
				fromFen,
				toFen,
				san,
				source: 'PERSONAL',
				notes: null,
				createdAt: new Date()
			})
			.returning();

		if (isUserTurn) {
			await tx.insert(userRepertoireMove).values({
				userId: user.id,
				repertoireId,
				fromFen,
				san,
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
			});
		}

		return { kind: 'created', move } as const;
	});

	if (outcome.kind === 'gone') throw error(404, 'Repertoire not found');
	if (outcome.kind === 'conflict') {
		return json(
			{ error: 'A different move already exists from this position', existing: outcome.existing },
			{ status: 409 }
		);
	}
	if (outcome.kind === 'created') return json(outcome.move, { status: 201 });
	return json(outcome.move);
};
