// Background evals of the positions reached by each candidate move in the
// Players tab, used only to color-code those rows (good / neutral / bad vs.
// the best evaluated move). Runs on the client Stockfish at TARGET_DEPTH,
// the same depth as the Engine tab, at the lowest priority: it never delays
// the Engine tab and yields to it instantly (see evaluatePositionBackground).
//
// Completed evals are shared through the server cache (/api/players/evals,
// table position_eval_cache): read in one batch before any search, written
// after each completed search. The cache holds RAW scores (side to move of
// the evaluated position); the flip to White's perspective happens only in
// toWhite() below.
//
// Deliberately separate from the Engine tab's MultiPV scores: those come
// from a search of the PARENT position and are not comparable with a
// depth-20 search of each CHILD position at the 20 cp granularity used for
// the coloring thresholds. Never mix the two in the same comparison.

import { Chess } from 'chess.js';
import { fenKey } from '$lib/fen';
import { evaluatePositionBackground, whenInteractiveIdle, stopBackgroundSearch } from './stockfish';

/** Upper bound on evaluated (and therefore colored) moves per position. */
export const MAX_EVALUATED_MOVES = 5;

/** A move beyond the first MIN_EVALUATED_MOVES is only evaluated if it accounts for at least this share of the games listed for the position. */
export const MIN_GAMES_SHARE = 0.05;

/** Always evaluate at least this many moves (when they exist): coloring compares against the best one, so a single eval means nothing. */
export const MIN_EVALUATED_MOVES = 2;

/** Eval of a resulting position, in WHITE's perspective (same convention as the Engine tab). */
export interface ChildEval {
	evalCp: number | null;
	evalMate: number | null;
}

/**
 * Eval of a position where the side to move has no legal move, in WHITE's
 * perspective, or null for any other position. The engine cannot be asked
 * about those: it answers "info depth 0" without a depth-20 result, which
 * would leave the move uncolored (the mating move is the best one) and,
 * for mate 0, lose the sign once flipped to White's perspective. A
 * delivered mate is reported as mate 1 for the side that delivered it: it
 * ties with a forced mate in one, which is fine for the coloring.
 */
export function terminalChildEval(chess: Chess): ChildEval | null {
	if (chess.isCheckmate()) return { evalCp: null, evalMate: chess.turn() === 'b' ? 1 : -1 };
	if (chess.isStalemate()) return { evalCp: 0, evalMate: null };
	return null;
}

interface MoveStat {
	san: string;
	totalGames: number;
}

/**
 * Picks which moves to evaluate: the most played ones, at most
 * MAX_EVALUATED_MOVES, dropping any beyond the first MIN_EVALUATED_MOVES
 * whose share of the listed games is below MIN_GAMES_SHARE. `moves` must be
 * sorted by totalGames descending (as /api/players returns them).
 */
export function selectMovesToEvaluate(moves: MoveStat[]): string[] {
	const total = moves.reduce((sum, m) => sum + m.totalGames, 0);
	const selected: string[] = [];
	for (const m of moves) {
		if (selected.length >= MAX_EVALUATED_MOVES) break;
		const keep =
			selected.length < MIN_EVALUATED_MOVES ||
			(total > 0 && m.totalGames / total >= MIN_GAMES_SHARE);
		if (!keep) break;
		selected.push(m.san);
	}
	return selected;
}

const EVALS_ENDPOINT = '/api/players/evals';

/** Raw engine score (side to move of the evaluated position) to White's perspective. The only place this flip is done. */
function toWhite(raw: ChildEval, whiteMultiplier: 1 | -1): ChildEval {
	return {
		evalCp: raw.evalCp !== null ? raw.evalCp * whiteMultiplier : null,
		evalMate: raw.evalMate !== null ? raw.evalMate * whiteMultiplier : null
	};
}

/** Reads cached RAW evals for `keys` (4-field FENs) in one request. Any failure yields an empty map: the cache is an optimisation, never a dependency. */
async function fetchCachedEvals(keys: string[]): Promise<Map<string, ChildEval>> {
	const found = new Map<string, ChildEval>();
	try {
		const query = keys.map((k) => `fen=${encodeURIComponent(k)}`).join('&');
		const res = await fetch(`${EVALS_ENDPOINT}?${query}`);
		if (!res.ok) return found;
		const data = (await res.json()) as { evals?: Record<string, ChildEval> };
		for (const [key, ev] of Object.entries(data.evals ?? {})) found.set(key, ev);
	} catch {
		// Offline, session expired, server error: fall back to local searches.
	}
	return found;
}

/** Stores a completed RAW eval, fire and forget: a failed write only means the position is recomputed next time. */
function storeCachedEval(key: string, raw: ChildEval): void {
	fetch(EVALS_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ fen: key, evalCp: raw.evalCp, evalMate: raw.evalMate })
	}).catch(() => {});
}

// Session-lifetime cache of completed depth-20 evals in WHITE's perspective,
// keyed by the 4-field FEN of the resulting position. Only completed
// searches (local or read from the server cache) are stored.
const MAX_CACHE_ENTRIES = 2000;
const sessionCache = new Map<string, ChildEval>();

function remember(key: string, value: ChildEval): void {
	if (sessionCache.size >= MAX_CACHE_ENTRIES) {
		const oldest = sessionCache.keys().next().value;
		if (oldest !== undefined) sessionCache.delete(oldest);
	}
	sessionCache.set(key, value);
}

export interface EvaluateChildrenOptions {
	/** Called once per move as soon as its eval is known (cache hit or fresh search), in the order of `sans`. */
	onEval: (san: string, ev: ChildEval) => void;
	/** Polled between and during searches; return true to abandon the remaining work. */
	isCancelled: () => boolean;
}

/**
 * Evaluates, one at a time, the position reached by playing each of `sans`
 * from `parentFen`. Resolves when everything is evaluated, the work was
 * cancelled, or a search failed. A search preempted by an interactive
 * call is retried from scratch once the Engine tab is idle again.
 */
export async function evaluateChildren(
	parentFen: string,
	sans: string[],
	{ onEval, isCancelled }: EvaluateChildrenOptions
): Promise<void> {
	interface Child {
		san: string;
		childFen: string;
		key: string;
		whiteMultiplier: 1 | -1;
		terminal: ChildEval | null;
	}

	const children: Child[] = [];
	for (const san of sans) {
		try {
			const chess = new Chess(parentFen);
			chess.move(san);
			const childFen = chess.fen();
			children.push({
				san,
				childFen,
				key: fenKey(childFen),
				whiteMultiplier: chess.turn() === 'w' ? 1 : -1,
				terminal: terminalChildEval(chess)
			});
		} catch {
			continue;
		}
	}

	// One batched read of the server cache for everything not already known.
	// Checkmate / stalemate are known without the engine and deliberately
	// kept out of every cache.
	const toLookUp = [
		...new Set(children.filter((c) => !c.terminal && !sessionCache.has(c.key)).map((c) => c.key))
	];
	if (toLookUp.length > 0 && !isCancelled()) {
		const hits = await fetchCachedEvals(toLookUp);
		for (const c of children) {
			const raw = hits.get(c.key);
			if (raw && !sessionCache.has(c.key)) remember(c.key, toWhite(raw, c.whiteMultiplier));
		}
	}

	for (const { san, childFen, key, whiteMultiplier, terminal } of children) {
		if (isCancelled()) return;

		if (terminal) {
			onEval(san, terminal);
			continue;
		}

		const cached = sessionCache.get(key);
		if (cached) {
			onEval(san, cached);
			continue;
		}

		while (!isCancelled()) {
			await whenInteractiveIdle();
			if (isCancelled()) return;

			const result = await evaluatePositionBackground(childFen, isCancelled);
			if (result.completed) {
				const raw: ChildEval = { evalCp: result.evalCp, evalMate: result.evalMate };
				remember(key, toWhite(raw, whiteMultiplier));
				// A completed search is valid even if the position was left
				// in the meantime: share it.
				storeCachedEval(key, raw);
				if (!isCancelled()) onEval(san, toWhite(raw, whiteMultiplier));
				break;
			}
			// Preempted or cancelled: loop (waits for the Engine tab, or exits
			// if cancelled). Anything else (watchdog failure) leaves this move
			// uncolored rather than blocking the others.
			if (!result.interrupted) break;
		}
	}
}

/** Stops the search currently running for evaluateChildren, if any. Call from the cleanup of the effect that started it. */
export function cancelChildEvals(): void {
	stopBackgroundSearch();
}
