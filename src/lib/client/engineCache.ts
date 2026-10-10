// Session-lifetime cache of the Engine tab's MultiPV results, so that coming
// back to a position already searched to the target depth shows the lines
// instantly, with no search and no debounce, and leaves the engine free for
// the background evals of the Players / Masters coloring.
//
// In memory only: gone on reload, which is deliberate (no invalidation to
// manage if the engine changes).
//
// Keyed by the 4-field FEN, so positions reached by transposition share one
// entry. The halfmove clock is ignored, which only matters for the 50-move
// rule, far outside what the Build and Review tabs study. The number of
// lines is part of the key: a 3-line result is not a 1-line one.
//
// Lines are stored RAW, from the perspective of the side to move, exactly as
// evaluatePositionMultiPv returns them. Callers flip them to White's
// perspective themselves.
//
// Deliberately separate from the Players / Masters child evals
// ($lib/client/playerEvals): a MultiPV search and a single-line search of
// the same position do not return the same score, so the two are never
// mixed. Only searches that reached the target depth must be stored; the
// caller decides, this module cannot know.

import { fenKey } from '$lib/fen';
import type { MultiPvLine } from './stockfish';

const MAX_ENTRIES = 500;
const cache = new Map<string, MultiPvLine[]>();

function cacheKey(fen: string, lines: number): string {
	return `${fenKey(fen)}|${lines}`;
}

/** The cached lines for `fen` (RAW, side to move), or null. A hit makes the entry the most recent. */
export function getCachedEngineLines(fen: string, lines: number): MultiPvLine[] | null {
	const key = cacheKey(fen, lines);
	const hit = cache.get(key);
	if (!hit) return null;
	cache.delete(key);
	cache.set(key, hit);
	return hit;
}

/** Stores the RAW lines of a search that reached the target depth. Evicts the least recently used entry when full. */
export function cacheEngineLines(fen: string, lines: number, result: MultiPvLine[]): void {
	if (result.length === 0) return;
	const key = cacheKey(fen, lines);
	cache.delete(key);
	if (cache.size >= MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, result);
}
