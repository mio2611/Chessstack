// POST /api/endgame/validate-move — checks one move played during an
// endgame drill session against the Lichess tablebase.
//
// Body: { fen, uci }  — fen is the position BEFORE the move, uci identifies
// which move was played (e.g. "e2e4", "e7e8q" for promotion).
//
// Returns: { found, sound, optimal, positionCategory, positionDtz, positionDtm, move }
//   - sound: the move didn't drop the WDL result class (Practice mode's check)
//   - optimal: the move tied the best available dtz among sound moves
//     (Theory mode's stricter check)
//   - found: false means the uci wasn't in the tablebase's move list for
//     this fen — the client sent something inconsistent with `fen`, not a
//     tablebase failure
//
// Errors from the tablebase (timeout, non-200, network failure) are
// surfaced as a 502 with a message the client can show — this is the first
// place in the app where a live per-move network call sits in an
// interactive loop, so the client is expected to handle this explicitly
// (pause, retry, or let the user continue unvalidated) rather than treat a
// failed fetch the same as an unsound move.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { evaluateMove, TablebaseApiError } from '$lib/tablebase';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	const { fen, uci } = body;
	if (typeof fen !== 'string' || typeof uci !== 'string') {
		throw error(400, 'fen and uci must be strings');
	}

	try {
		const evaluation = await evaluateMove(fen, uci);
		return json(evaluation);
	} catch (err) {
		if (err instanceof TablebaseApiError) {
			throw error(502, `Tablebase unavailable: ${err.message}`);
		}
		throw err;
	}
};
