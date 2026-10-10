// Background evals of the positions reached by each candidate move in the
// Players tab, used only to color-code those rows (good / neutral / bad vs.
// the best evaluated move). Runs on the client Stockfish at TARGET_DEPTH,
// the same depth as the Engine tab, at the lowest priority: it never delays
// the Engine tab and yields to it instantly (see evaluatePositionBackground).
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

// Session-lifetime cache of completed depth-20 evals, keyed by the 4-field
// FEN of the resulting position. Only completed searches are stored.
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
	for (const san of sans) {
		if (isCancelled()) return;

		let childFen: string;
		let whiteMultiplier: 1 | -1;
		let terminal: ChildEval | null;
		try {
			const chess = new Chess(parentFen);
			chess.move(san);
			childFen = chess.fen();
			whiteMultiplier = chess.turn() === 'w' ? 1 : -1;
			terminal = terminalChildEval(chess);
		} catch {
			continue;
		}

		// Checkmate / stalemate: known without the engine, and deliberately
		// kept out of every cache.
		if (terminal) {
			onEval(san, terminal);
			continue;
		}

		const key = fenKey(childFen);
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
				const ev: ChildEval = {
					evalCp: result.evalCp !== null ? result.evalCp * whiteMultiplier : null,
					evalMate: result.evalMate !== null ? result.evalMate * whiteMultiplier : null
				};
				remember(key, ev);
				if (!isCancelled()) onEval(san, ev);
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
