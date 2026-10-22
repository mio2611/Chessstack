// Line mode of the drill: which root-to-leaf lines exist, which are due, and in
// what order to drill them.
//
// Pure functions, no UI: the drill page calls them, and they can be run and
// tested on their own.
//
// Why there is no small cap on the number of lines. Lines used to be capped at
// 500 *while walking the tree*, before the "due" filter and the weakness sort
// ran. In a repertoire with more lines than that, the ones past the 500th in
// walk order never made it into a session, even when they held due cards: the
// start screen could say "All caught up!" with cards due. So the whole tree is
// walked, and only then filtered and sorted. The bounds below exist for one
// reason: transpositions multiply paths (k layers of two move orders give 2^k
// lines), and an unbounded walk of such a graph would run out of memory.

import { fenKey, STARTING_FEN } from '$lib/fen';
import { buildInScopeFens, getEffectiveStartFens } from '$lib/repertoire';

/** One step in a root-to-leaf line through the repertoire tree. */
export interface LineStep {
	fromFen: string;
	toFen: string;
	san: string;
	isUserMove: boolean; // true when it's the user's color to move
}

/** The part of a stored move the line walk needs. */
export interface LineMove {
	fromFen: string;
	toFen: string;
	san: string;
}

/** Most lines enumerated. Far above any real repertoire (thousands at most). */
export const MAX_ENUMERATED_LINES = 20_000;

/** Most tree positions visited, in case many paths never form a countable line. */
const MAX_VISITS = 2_000_000;

export interface LineEnumeration {
	lines: LineStep[][];
	/** True when a bound was hit: the lines below are only the first ones found. */
	truncated: boolean;
}

/**
 * Enumerate all root-to-leaf lines through the repertoire's move tree.
 * A "leaf" is any position with no outgoing edges. Each line is an ordered
 * list of LineSteps from the starting position to the leaf.
 *
 * Lead-in moves (before the repertoire's effective start position, see
 * getEffectiveStartFens) are still walked and auto-played for context,
 * but are never marked isUserMove, even when they fall on the user's own
 * turn. This mirrors card mode and the Gap Finder, which both exclude
 * lead-in positions from what's actively drilled: the "Set Start"
 * button in Build Mode promises exactly that ("moves before it won't be
 * drilled").
 *
 * `customStartFen` is the repertoire's startFen. The lead-in exclusion only
 * makes sense for a custom start position. When it is null,
 * getEffectiveStartFens would define scope as starting *after* the user's
 * own first move (a convention meant for SR-card/gap scoping, where the first
 * move itself is never quizzed); reusing that here would wrongly auto-play the
 * user's actual first move in every line.
 */
export function enumerateLines(
	moves: LineMove[],
	color: 'WHITE' | 'BLACK',
	customStartFen: string | null
): LineEnumeration {
	const adj = new Map<string, LineMove[]>();
	for (const m of moves) {
		const key = fenKey(m.fromFen);
		const list = adj.get(key);
		if (list) list.push(m);
		else adj.set(key, [m]);
	}

	const inScope = customStartFen
		? buildInScopeFens(getEffectiveStartFens(customStartFen, moves, color), moves)
		: null;

	const lines: LineStep[][] = [];
	let truncated = false;
	let visits = 0;

	function isUserTurn(fen: string): boolean {
		const sideToMove = fen.split(' ')[1]; // 'w' or 'b'
		return (color === 'WHITE' && sideToMove === 'w') || (color === 'BLACK' && sideToMove === 'b');
	}

	function dfs(fen: string, path: LineStep[], visited: Set<string>): void {
		if (truncated) return;
		if (++visits > MAX_VISITS) {
			truncated = true;
			return;
		}

		const children = adj.get(fenKey(fen)) ?? [];
		if (children.length === 0) {
			// Leaf: only record if path has at least one user move.
			if (path.some((s) => s.isUserMove)) {
				if (lines.length >= MAX_ENUMERATED_LINES) {
					truncated = true;
					return;
				}
				lines.push([...path]);
			}
			return;
		}

		for (const child of children) {
			const toKey = fenKey(child.toFen);
			if (visited.has(toKey)) continue; // cycle protection

			visited.add(toKey);
			path.push({
				fromFen: child.fromFen,
				toFen: child.toFen,
				san: child.san,
				isUserMove:
					isUserTurn(child.fromFen) && (inScope === null || inScope.has(fenKey(child.fromFen)))
			});
			dfs(child.toFen, path, visited);
			path.pop();
			visited.delete(toKey);
		}
	}

	dfs(STARTING_FEN, [], new Set<string>([fenKey(STARTING_FEN)]));
	return { lines, truncated };
}

/**
 * The cards of a session as a set of "position:san" keys. Built once and shared
 * by lineHasDueStep and scoreLine: rebuilding it for every line made the filter
 * and the sort quadratic (seconds for a few thousand lines).
 */
export function indexCards(cards: { fromFen: string; san: string }[]): Set<string> {
	return new Set(cards.map((c) => fenKey(c.fromFen) + ':' + c.san));
}

/**
 * Whether a line contains at least one step matching a card of the session.
 * Used to scope line mode to "due" the same way card mode already is:
 * enumerateLines produces every line in the tree regardless of due status,
 * sortLinesByWeakness only orders them, so without this filter "due" line-mode
 * sessions would silently drill (and auto-grade) the whole repertoire,
 * duplicating what the existing "Drill all cards" link (?mode=all) is for.
 */
export function lineHasDueStep(line: LineStep[], cards: ReadonlySet<string>): boolean {
	return line.some((s) => s.isUserMove && cards.has(fenKey(s.fromFen) + ':' + s.san));
}

/**
 * Score a line by how many of its user moves have a card in the session.
 * Higher score = more urgent to drill.
 */
export function scoreLine(line: LineStep[], cards: ReadonlySet<string>): number {
	let score = 0;
	for (const step of line) {
		if (!step.isUserMove) continue;
		if (cards.has(fenKey(step.fromFen) + ':' + step.san)) score += 3;
	}
	return score;
}

/** Sort lines by score descending, breaking ties randomly. */
export function sortLinesByWeakness(lines: LineStep[][], cards: ReadonlySet<string>): LineStep[][] {
	const scored = lines.map((line) => ({
		line,
		score: scoreLine(line, cards),
		rand: Math.random()
	}));
	scored.sort((a, b) => b.score - a.score || a.rand - b.rand);
	return scored.map((s) => s.line);
}
