// Which moves of a repertoire stop being reachable when its move tree changes.
//
// A repertoire is not a tree but a graph: transpositions let several paths reach
// the same position, and a line can even come back to an earlier position
// (1.Nf3 Nf6 2.Ng1 Ng8). So "the moves below this one" is the wrong question when
// something is deleted or replaced. The right one is: after the change, which
// moves can no longer be reached from the roots of the tree? Only those go.
//
// Shared by the server (what to delete) and the Build page (what to show), so
// the screen and the database cannot disagree.

import { fenKey, STARTING_FEN } from '$lib/fen';
import { buildInScopeFens } from '$lib/repertoire';

/** Minimal move shape: works with userMove rows and with the client's moves. */
export interface TreeMove {
	id: number;
	fromFen: string;
	toFen: string;
	san: string;
}

/**
 * Positions the tree is walked from.
 *
 * - STARTING_FEN: the root of every repertoire (lead-in moves included).
 * - the repertoire's custom startFen, when it has one.
 * - the position the change happens at: moves in a part of the tree that is not
 *   connected to the other roots are then still cleaned up below the change,
 *   instead of being left behind.
 */
export function treeRoots(startFen: string | null, changedFromFen: string): string[] {
	const roots = [STARTING_FEN, changedFromFen];
	if (startFen) roots.push(startFen);
	return roots;
}

/**
 * Ids of the moves that are reachable from `roots` in `before` but not in
 * `after`. Only moves present in `after` are returned: the moves removed by the
 * change itself are the caller's business.
 *
 * Breadth-first with a visited set, so cycles are safe. Moves that were already
 * unreachable before the change are left alone (not this change's doing).
 */
export function findOrphanedMoveIds(
	before: TreeMove[],
	after: TreeMove[],
	roots: string[]
): number[] {
	const reachableBefore = buildInScopeFens(roots, before);
	const reachableAfter = buildInScopeFens(roots, after);
	return after
		.filter((m) => {
			const key = fenKey(m.fromFen);
			return reachableBefore.has(key) && !reachableAfter.has(key);
		})
		.map((m) => m.id);
}
