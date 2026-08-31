/**
 * moveGraphBuilder.ts
 * ───────────────────
 * Builds a deduplicated DAG (nodes + edges) from a flat list of repertoire
 * moves, for the graph tree view (GraphView.svelte).
 *
 * Unlike moveTreeBuilder.ts (used by the existing text view), a position
 * reached by more than one move sequence — a transposition — is represented
 * here as a SINGLE node with multiple incoming edges, not duplicated. This
 * matches how Openchess renders its graph: two branches visually merge into
 * one block instead of each carrying its own copy of everything below it.
 *
 * Each node still carries one representative `pathSans` (the first path that
 * reached it, via breadth-first search from the root) so that clicking it can
 * reuse the existing SAN-replay navigation in buildState.svelte.ts
 * (`replayLine`), which has no notion of "jump directly to a FEN" — it always
 * re-simulates a move sequence from the starting position.
 */

import { fenKey, STARTING_FEN } from '$lib/fen';

interface MoveInput {
	fromFen: string;
	toFen: string;
	san: string;
	createdAt: Date | string | number;
}

interface MoveEdge {
	san: string;
	fromFen: string;
	toFen: string;
	createdAt: number;
}

export interface GraphNode {
	fenKey: string;
	fen: string; // one representative FEN for this position (all incoming edges share the same fenKey)
	ply: number; // BFS distance from the root — used as a layout hint, not a move number
	pathSans: string[]; // one representative path from the root, for click-to-navigate
}

export interface GraphEdge {
	id: string; // `${fromKey}->${san}->${toKey}` — unique per edge
	fromKey: string;
	toKey: string;
	san: string;
}

export interface MoveGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

function buildAdjacencyMap(moves: MoveInput[]): Map<string, MoveEdge[]> {
	const map = new Map<string, MoveEdge[]>();
	for (const m of moves) {
		const key = fenKey(m.fromFen);
		let arr = map.get(key);
		if (!arr) {
			arr = [];
			map.set(key, arr);
		}
		arr.push({
			san: m.san,
			fromFen: m.fromFen,
			toFen: m.toFen,
			createdAt:
				m.createdAt instanceof Date
					? m.createdAt.getTime()
					: typeof m.createdAt === 'number'
						? m.createdAt
						: new Date(m.createdAt).getTime()
		});
	}
	// Sort by createdAt ascending — first-added move = mainline, consistent
	// with moveTreeBuilder.ts, so a node's representative path tends to
	// follow the same mainline a user would expect when clicked.
	for (const arr of map.values()) {
		arr.sort((a, b) => a.createdAt - b.createdAt);
	}
	return map;
}

/**
 * Build a deduplicated graph from a flat list of repertoire moves.
 *
 * BFS from the root, not DFS: this guarantees each node's representative
 * `pathSans` is a shortest path from the root, so `ply` never overstates a
 * node's true distance even when it's also reachable via a longer route.
 *
 * @param moves     All user moves for the repertoire
 * @param startFen  Optional custom start position (graph root)
 */
export function buildMoveGraph(moves: MoveInput[], startFen: string | null): MoveGraph {
	if (moves.length === 0) return { nodes: [], edges: [] };

	const adj = buildAdjacencyMap(moves);
	const rootFen = startFen ?? STARTING_FEN;
	const rootKey = fenKey(rootFen);

	const nodes = new Map<string, GraphNode>();
	nodes.set(rootKey, { fenKey: rootKey, fen: rootFen, ply: 0, pathSans: [] });

	const edges: GraphEdge[] = [];
	const queue: Array<{ key: string; ply: number; path: string[] }> = [
		{ key: rootKey, ply: 0, path: [] }
	];

	while (queue.length > 0) {
		const current = queue.shift()!;
		const outgoing = adj.get(current.key);
		if (!outgoing) continue;

		for (const edge of outgoing) {
			const toKey = fenKey(edge.toFen);
			const nodePath = [...current.path, edge.san];

			edges.push({
				id: `${current.key}->${edge.san}->${toKey}`,
				fromKey: current.key,
				toKey,
				san: edge.san
			});

			if (!nodes.has(toKey)) {
				nodes.set(toKey, {
					fenKey: toKey,
					fen: edge.toFen,
					ply: current.ply + 1,
					pathSans: nodePath
				});
				queue.push({ key: toKey, ply: current.ply + 1, path: nodePath });
			}
			// else: toKey already has a node — this is a transposition. The edge
			// above is still recorded, so the layout draws a second incoming
			// line into the same node, but the node itself is not duplicated
			// and its subtree is not re-traversed.
		}
	}

	return { nodes: Array.from(nodes.values()), edges };
}
