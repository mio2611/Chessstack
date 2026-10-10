// GET  /api/players/evals?fen=<fen>&fen=<fen>...
// POST /api/players/evals   { fen, evalCp, evalMate }
//
// Shared cache (table position_eval_cache) of the depth-20 evals of the
// positions reached by the candidate moves of the Players tab. The evals are
// computed by the client Stockfish (see $lib/client/playerEvals); this
// endpoint only serves and stores them, it never runs an engine.
//
// Stored RAW: from the perspective of the side to move in `fen`, which is
// Stockfish's own convention. Readers flip to White's perspective themselves,
// in one place (playerEvals.ts). Not user-scoped: an engine eval of a
// position is the same for everyone on the instance.
//
// The client is untrusted: it only chooses the position and the score. The
// depth is imposed here, the FEN must be canonical and non-terminal, the
// score is bounded, and an existing row is never overwritten. What cannot be
// checked without an engine is that the score is the true one: an
// authenticated user could store a wrong value for a position nobody has
// cached yet, and it would then stay (no overwrite). Acceptable on a
// single-user or trusted instance.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Chess } from 'chess.js';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/db';
import { positionEvalCache } from '$lib/db/schema';
import { fenKey, sanitizeFen, toFullFen } from '$lib/fen';

// Depth of every row read and written here. Must match TARGET_DEPTH in
// $lib/client/stockfish.ts, the depth the client actually searches at.
const EVAL_DEPTH = 20;

// Same as the number of moves /api/players returns.
const MAX_FENS = 12;

// Centipawn bound, and bound on the distance to mate in moves. Anything
// outside is rejected rather than clamped: a clamped value would be stored
// as if it were a real eval.
const MAX_ABS_CP = 10_000;
const MAX_ABS_MATE = 500;

/**
 * Canonical 4-field key of a FEN, or null if it is malformed or not in the
 * exact form chess.js produces (same form the client derives with
 * fenKey(chess.fen())). Requiring the canonical form keeps one row per
 * position: an en-passant square chess.js would drop, for instance, would
 * otherwise create a row no lookup ever hits.
 */
function canonicalKey(raw: unknown): { key: string; chess: Chess } | null {
	const fen = sanitizeFen(raw);
	if (!fen) return null;
	const key = fenKey(fen);
	if (key.split(' ').length !== 4) return null;
	try {
		const chess = new Chess(toFullFen(key));
		if (fenKey(chess.fen()) !== key) return null;
		return { key, chess };
	} catch {
		return null;
	}
}

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const raw = url.searchParams.getAll('fen');
	if (raw.length === 0) throw error(400, 'fen query parameter is required');
	if (raw.length > MAX_FENS) throw error(400, `at most ${MAX_FENS} fen parameters`);

	const keys = new Set<string>();
	for (const value of raw) {
		const fen = sanitizeFen(value);
		if (!fen) throw error(400, 'invalid fen');
		keys.add(fenKey(fen));
	}

	const rows = await db
		.select({
			fen: positionEvalCache.fen,
			evalCp: positionEvalCache.evalCp,
			evalMate: positionEvalCache.evalMate
		})
		.from(positionEvalCache)
		.where(and(inArray(positionEvalCache.fen, [...keys]), eq(positionEvalCache.depth, EVAL_DEPTH)));

	// Raw perspective (side to move in each fen), keyed by 4-field FEN.
	const evals: Record<string, { evalCp: number | null; evalMate: number | null }> = {};
	for (const r of rows) evals[r.fen] = { evalCp: r.evalCp, evalMate: r.evalMate };
	return json({ evals });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	let body: { fen?: unknown; evalCp?: unknown; evalMate?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const parsed = canonicalKey(body.fen);
	if (!parsed) throw error(400, 'fen must be a valid canonical 4-field FEN');
	// Terminal positions are never searched (the client knows their value
	// without the engine), so they have no business in the cache.
	if (parsed.chess.isCheckmate() || parsed.chess.isStalemate()) {
		throw error(400, 'checkmate and stalemate positions are not cached');
	}

	const { evalCp, evalMate } = body;
	const hasCp = evalCp !== null && evalCp !== undefined;
	const hasMate = evalMate !== null && evalMate !== undefined;
	if (hasCp === hasMate) throw error(400, 'exactly one of evalCp and evalMate is required');

	if (hasCp) {
		if (typeof evalCp !== 'number' || !Number.isInteger(evalCp) || Math.abs(evalCp) > MAX_ABS_CP) {
			throw error(400, `evalCp must be an integer within ±${MAX_ABS_CP}`);
		}
	} else if (
		typeof evalMate !== 'number' ||
		!Number.isInteger(evalMate) ||
		evalMate === 0 ||
		Math.abs(evalMate) > MAX_ABS_MATE
	) {
		throw error(400, `evalMate must be a non-zero integer within ±${MAX_ABS_MATE}`);
	}

	await db
		.insert(positionEvalCache)
		.values({
			fen: parsed.key,
			depth: EVAL_DEPTH,
			evalCp: hasCp ? (evalCp as number) : null,
			evalMate: hasMate ? (evalMate as number) : null
		})
		.onConflictDoNothing();

	return new Response(null, { status: 204 });
};
