// Background evals of a position and of the positions reached by each of its
// candidate moves (Players and Masters tabs), used only to color-code those
// rows by the centipawn loss of the move for the side that plays it: the
// eval of the parent position is the reference, so a move has the same color
// in every tab. Runs on the client Stockfish at TARGET_DEPTH,
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

/** Always evaluate at least this many moves (when they exist). Kept from the time the coloring compared moves with each other; the parent position is now the reference, so this only fixes how many moves get a color. */
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
	/**
	 * Called once with the eval of the parent position itself, in WHITE's
	 * perspective, before any child. It is the reference every move is
	 * compared with: if it cannot be obtained, no child is evaluated.
	 */
	onParentEval: (ev: ChildEval) => void;
	/** Called once per move as soon as its eval is known (cache hit or fresh search), in the order of `sans`. */
	onEval: (san: string, ev: ChildEval) => void;
	/** Polled between and during searches; return true to abandon the remaining work. */
	isCancelled: () => boolean;
}

/** A position to evaluate: engine FEN, 4-field cache key, and the sign that flips a raw score to White's perspective. */
interface Target {
	fen: string;
	key: string;
	whiteMultiplier: 1 | -1;
	terminal: ChildEval | null;
}

function makeTarget(chess: Chess): Target {
	const fen = chess.fen();
	return {
		fen,
		key: fenKey(fen),
		whiteMultiplier: chess.turn() === 'w' ? 1 : -1,
		terminal: terminalChildEval(chess)
	};
}

/**
 * Eval of one position in WHITE's perspective: from the session cache, else
 * by a background search (retried from scratch after each preemption by the
 * Engine tab), then shared with the server cache. Resolves to null if the
 * work was cancelled or the search failed (watchdog).
 */
async function resolveEval(target: Target, isCancelled: () => boolean): Promise<ChildEval | null> {
	// Checkmate / stalemate: known without the engine, and deliberately
	// kept out of every cache.
	if (target.terminal) return target.terminal;

	const cached = sessionCache.get(target.key);
	if (cached) return cached;

	while (!isCancelled()) {
		await whenInteractiveIdle();
		if (isCancelled()) return null;

		const result = await evaluatePositionBackground(target.fen, isCancelled);
		if (result.completed) {
			const raw: ChildEval = { evalCp: result.evalCp, evalMate: result.evalMate };
			const white = toWhite(raw, target.whiteMultiplier);
			remember(target.key, white);
			// A completed search is valid even if the position was left in
			// the meantime: share it.
			storeCachedEval(target.key, raw);
			return white;
		}
		// Preempted or cancelled: loop (waits for the Engine tab, or exits
		// if cancelled). Anything else (watchdog failure) gives up on this
		// position only.
		if (!result.interrupted) return null;
	}
	return null;
}

/**
 * Evaluates, one at a time, `parentFen` first and then the position reached
 * by playing each of `sans` from it. Resolves when everything is evaluated,
 * the work was cancelled, or the parent could not be evaluated.
 */
export async function evaluateChildren(
	parentFen: string,
	sans: string[],
	{ onParentEval, onEval, isCancelled }: EvaluateChildrenOptions
): Promise<void> {
	let parent: Target;
	try {
		// Through chess.js so that the key is the canonical form the server
		// cache expects, whatever shape the caller's FEN has.
		parent = makeTarget(new Chess(parentFen));
	} catch {
		return;
	}

	const children: { san: string; target: Target }[] = [];
	for (const san of sans) {
		try {
			const chess = new Chess(parentFen);
			chess.move(san);
			children.push({ san, target: makeTarget(chess) });
		} catch {
			continue;
		}
	}

	// One batched read of the server cache for everything not already known.
	const targets = [parent, ...children.map((c) => c.target)];
	const toLookUp = [
		...new Set(targets.filter((t) => !t.terminal && !sessionCache.has(t.key)).map((t) => t.key))
	];
	if (toLookUp.length > 0 && !isCancelled()) {
		const hits = await fetchCachedEvals(toLookUp);
		for (const t of targets) {
			const raw = hits.get(t.key);
			if (raw && !sessionCache.has(t.key)) remember(t.key, toWhite(raw, t.whiteMultiplier));
		}
	}

	const parentEv = await resolveEval(parent, isCancelled);
	if (!parentEv || isCancelled()) return;
	onParentEval(parentEv);

	for (const { san, target } of children) {
		if (isCancelled()) return;
		const ev = await resolveEval(target, isCancelled);
		if (ev && !isCancelled()) onEval(san, ev);
	}
}

/** Stops the search currently running for evaluateChildren, if any. Call from the cleanup of the effect that started it. */
export function cancelChildEvals(): void {
	stopBackgroundSearch();
}
