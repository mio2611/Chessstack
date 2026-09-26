// POST /api/stockfish
//
// Given a board position (FEN), returns book moves from the shared opening
// book for this position. Engine candidates used to be available from this
// endpoint too (mode 'engine'/'both'); the Build/Review engine tab now runs
// entirely client-side (see $lib/client/stockfish) and no caller requests
// anything but book moves any more, so that branch — and the depth/timeout
// settings lookup and getTopMoves call it needed — was removed rather than
// kept as dead code.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { bookMove, ecoOpening } from '$lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { Chess } from 'chess.js';
import { fenKey } from '$lib/fen';

// Shape of each candidate move returned to the browser. `evalCp`/`evalMate`
// are always null here (book moves are never engine-annotated — see the
// comment below) but kept on the type since the client's Candidate shape
// still has them for the engine-tab candidates it computes itself.
export interface Candidate {
	san: string; // move in Standard Algebraic Notation, e.g. "e4", "Nf3"
	uci: string; // UCI notation, e.g. "e2e4" — used internally
	evalCp: number | null;
	evalMate: number | null;
	isBook: boolean; // true if this move appears in the shared opening book
	annotation: string | null; // curator note for book moves, e.g. "main line"
	openingName: string | null; // ECO opening name for the position this move leads to
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	let body: { fen?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	const { fen } = body;

	if (!fen || typeof fen !== 'string') throw error(400, 'fen is required');
	if (fen.length > 100) throw error(400, 'fen is too long');

	// Normalize to 4-field FEN for DB lookups (book and eco tables store 4-field).
	const fenNorm = fenKey(fen);

	// ── 1. Book lookup ────────────────────────────────────────────────────────
	// Find all known opening moves from this exact position.
	const bookMoves = await db.select().from(bookMove).where(eq(bookMove.fromFen, fenNorm));

	// ── 2. Look up ECO opening names for positions reached by book moves ──────
	// Each book move has a toFen — the position after the move is played. We batch
	// query eco_opening to find a name for each resulting position in one round-trip.
	const toFens = bookMoves.map((bm) => bm.toFen).filter(Boolean) as string[];
	const openingRows =
		toFens.length > 0
			? await db.select().from(ecoOpening).where(inArray(ecoOpening.fen, toFens))
			: [];
	const fenToOpeningName = new Map(openingRows.map((r) => [r.fen, r.name]));

	// ── 3. Build the candidate list ─────────────────────────────────────────────
	// Book moves — no engine eval. The book is the authoritative source for
	// opening theory; cross-referencing with engine scores would be misleading
	// (engine evals in opening positions are rarely meaningful).
	const candidates: Candidate[] = [];
	for (const bm of bookMoves) {
		// Convert SAN → UCI to compute the from/to squares for the UCI field.
		const tempChess = new Chess(fen);
		const result = tempChess.move(bm.san);
		if (!result) continue; // Skip if the book somehow contains an illegal move.

		const uci = result.from + result.to + (result.promotion ?? '');
		candidates.push({
			san: bm.san,
			uci,
			evalCp: null,
			evalMate: null,
			isBook: true,
			annotation: bm.annotation ?? null,
			openingName: bm.toFen ? (fenToOpeningName.get(bm.toFen) ?? null) : null
		});
	}

	return json({ candidates });
};

