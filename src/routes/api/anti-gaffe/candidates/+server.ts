// GET/POST /api/anti-gaffe/candidates
//
// GET  ?gameSource=imported|reviewed&gameId=N[&status=pending|accepted|rejected]
//      Lists anti-gaffe candidates for one specific game (the Anti-gaffe tab
//      is scoped per-game, same as the Deviation tab). Omit status to get
//      every candidate regardless of status.
//
// POST Creates one candidate. Called by the client-side scan loop (see
//      $lib/client/stockfish + the anti-gaffe scan, step 3c-ii) once per
//      position that passes its own filter — written progressively, one
//      row at a time, rather than batched at the end of the scan, so a
//      long scan session that gets interrupted doesn't lose what it already
//      found.
//
// Both the eval-window and cp-loss thresholds are re-validated here rather
// than trusted from the client — the client's own filter should already
// guarantee them, but cp_loss specifically is recomputed server-side from
// eval_before_cp/eval_after_cp and the FEN's side to move, the same way
// review's computeCpl does it, rather than trusting a client-sent number.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Chess } from 'chess.js';
import { db } from '$lib/db';
import { importedGame, reviewedGame, antiGaffeCandidate } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { fenKey } from '$lib/fen';

const EVAL_WINDOW_MAX = 300; // eval_before_cp must be within [-300, 300]
const MIN_CP_LOSS = 100;

async function verifyGameOwnership(
	userId: number,
	gameSource: string,
	gameId: number
): Promise<boolean> {
	if (gameSource === 'imported') {
		const [row] = await db
			.select({ id: importedGame.id })
			.from(importedGame)
			.where(and(eq(importedGame.id, gameId), eq(importedGame.userId, userId)));
		return !!row;
	}
	if (gameSource === 'reviewed') {
		const [row] = await db
			.select({ id: reviewedGame.id })
			.from(reviewedGame)
			.where(and(eq(reviewedGame.id, gameId), eq(reviewedGame.userId, userId)));
		return !!row;
	}
	return false;
}

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const gameSource = url.searchParams.get('gameSource');
	const gameIdParam = url.searchParams.get('gameId');
	const status = url.searchParams.get('status');

	if (gameSource !== 'imported' && gameSource !== 'reviewed') {
		throw error(400, 'gameSource must be "imported" or "reviewed"');
	}
	const gameId = gameIdParam ? parseInt(gameIdParam) : NaN;
	if (isNaN(gameId)) throw error(400, 'gameId is required and must be a number');

	if (!(await verifyGameOwnership(locals.user.id, gameSource, gameId))) {
		throw error(404, 'Game not found');
	}

	const gameColumn =
		gameSource === 'imported'
			? antiGaffeCandidate.importedGameId
			: antiGaffeCandidate.reviewedGameId;

	const conditions = [eq(gameColumn, gameId)];
	if (status) conditions.push(eq(antiGaffeCandidate.status, status));

	const candidates = await db
		.select()
		.from(antiGaffeCandidate)
		.where(and(...conditions))
		.orderBy(antiGaffeCandidate.ply);

	return json(candidates);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const userId = locals.user.id;

	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const {
		gameSource,
		gameId,
		ply,
		fen: rawFen,
		playedSan,
		evalBeforeCp,
		evalAfterCp,
		bestMoveUci,
		bestMoveSan
	} = body;

	if (gameSource !== 'imported' && gameSource !== 'reviewed') {
		throw error(400, 'gameSource must be "imported" or "reviewed"');
	}
	if (typeof gameId !== 'number') throw error(400, 'gameId must be a number');
	if (typeof ply !== 'number') throw error(400, 'ply must be a number');
	if (!rawFen || typeof rawFen !== 'string' || rawFen.length > 100) {
		throw error(400, 'fen is required and must be a string under 100 characters');
	}
	if (!playedSan || typeof playedSan !== 'string') throw error(400, 'playedSan is required');
	if (typeof evalBeforeCp !== 'number' || typeof evalAfterCp !== 'number') {
		throw error(400, 'evalBeforeCp and evalAfterCp must be numbers');
	}
	if (Math.abs(evalBeforeCp) > EVAL_WINDOW_MAX) {
		throw error(400, `evalBeforeCp must be within [-${EVAL_WINDOW_MAX}, ${EVAL_WINDOW_MAX}]`);
	}

	if (!(await verifyGameOwnership(userId, gameSource, gameId))) {
		throw error(404, 'Game not found');
	}

	const fen = fenKey(rawFen);

	// Recompute cp_loss server-side from the FEN's side to move — mirrors
	// review's computeCpl (fromFen.split(' ')[1]) rather than trusting a
	// client-sent value.
	let mover: 'w' | 'b';
	try {
		mover = new Chess(fen).turn();
	} catch {
		throw error(400, 'Invalid FEN');
	}
	const cpLoss = mover === 'w' ? evalBeforeCp - evalAfterCp : evalAfterCp - evalBeforeCp;
	if (cpLoss < MIN_CP_LOSS) {
		throw error(400, `cp_loss (${cpLoss}) is below the ${MIN_CP_LOSS}cp threshold`);
	}

	// Re-scanning a game (the button doesn't prevent it, and re-opening an
	// already-scanned game is a normal thing to do) must never create a
	// second row for a mistake already known at this exact ply — that's
	// what produced literal duplicates in the list before this check
	// existed. A candidate already decided (accepted/rejected) is left
	// untouched — a rescan should never resurrect a decision the user
	// already made. A still-pending one is refreshed in place with the
	// fresh numbers rather than duplicated.
	const gameColumn =
		gameSource === 'imported'
			? antiGaffeCandidate.importedGameId
			: antiGaffeCandidate.reviewedGameId;

	const [existing] = await db
		.select()
		.from(antiGaffeCandidate)
		.where(and(eq(gameColumn, gameId), eq(antiGaffeCandidate.ply, ply)));

	if (existing) {
		if (existing.status !== 'pending') {
			return json(existing, { status: 200 });
		}
		const [updated] = await db
			.update(antiGaffeCandidate)
			.set({
				fen,
				playedSan,
				evalBeforeCp,
				evalAfterCp,
				cpLoss,
				bestMoveUci: typeof bestMoveUci === 'string' ? bestMoveUci : null,
				bestMoveSan: typeof bestMoveSan === 'string' ? bestMoveSan : null
			})
			.where(eq(antiGaffeCandidate.id, existing.id))
			.returning();
		return json(updated, { status: 200 });
	}

	const [candidate] = await db
		.insert(antiGaffeCandidate)
		.values({
			userId,
			importedGameId: gameSource === 'imported' ? gameId : null,
			reviewedGameId: gameSource === 'reviewed' ? gameId : null,
			ply,
			fen,
			playedSan,
			evalBeforeCp,
			evalAfterCp,
			cpLoss,
			bestMoveUci: typeof bestMoveUci === 'string' ? bestMoveUci : null,
			bestMoveSan: typeof bestMoveSan === 'string' ? bestMoveSan : null,
			createdAt: new Date()
		})
		.returning();

	return json(candidate, { status: 201 });
};
