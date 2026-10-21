// POST /api/import/execute
//
// Batch-insert PGN-imported moves into the user's repertoire.
// All writes happen in a single transaction for atomicity.
//
// Input: {
//   repertoireId: number,
//   moves: { fromFen: string, san: string }[],          // all moves to import
//   replacements: { fromFen: string, san: string }[]     // conflicts resolved by user
// }
//
// Output: { inserted: number, replaced: number, skipped: number, unreachable: number }
//
// Only moves reachable from the starting position are written. A move whose
// position cannot be reached through the repertoire as it will stand after the
// import (typically the continuation of a PGN move the user refused in a
// conflict) is not inserted and is counted in `unreachable`.
//
// Security: toFen is computed server-side for every move (never from client).
// Mirrors the pattern in POST /api/moves and POST /api/review/add-move.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { Chess } from 'chess.js';
import { db } from '$lib/db';
import { repertoire, userMove, userRepertoireMove } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { fenKey, STARTING_FEN } from '$lib/fen';
import { replaceUserMove } from '$lib/server/replace-move';
import { lockRepertoire } from '$lib/server/repertoire-lock';

// Transaction type extracted from db.transaction() callback parameter
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// fromFen -> (san -> toFen), for every move currently stored in a repertoire.
type EdgeMap = Map<string, Map<string, string>>;

async function loadEdges(tx: Transaction, repertoireId: number): Promise<EdgeMap> {
	const rows = await tx
		.select({ fromFen: userMove.fromFen, toFen: userMove.toFen, san: userMove.san })
		.from(userMove)
		.where(eq(userMove.repertoireId, repertoireId));

	const edges: EdgeMap = new Map();
	for (const r of rows) {
		let children = edges.get(r.fromFen);
		if (!children) {
			children = new Map();
			edges.set(r.fromFen, children);
		}
		children.set(r.san, r.toFen);
	}
	return edges;
}

// Every position (fenKey) reachable from the starting position by following
// stored moves. The visited set makes repetition cycles harmless.
function computeReachable(edges: EdgeMap): Set<string> {
	const root = fenKey(STARTING_FEN);
	const reachable = new Set<string>([root]);
	const stack = [root];
	while (stack.length > 0) {
		const fen = stack.pop()!;
		const children = edges.get(fen);
		if (!children) continue;
		for (const toFen of children.values()) {
			if (!reachable.has(toFen)) {
				reachable.add(toFen);
				stack.push(toFen);
			}
		}
	}
	return reachable;
}

interface MoveInput {
	fromFen: string;
	san: string;
	annotation?: string | null;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Not authenticated');
	const user = locals.user;

	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const {
		repertoireId,
		moves,
		replacements = []
	} = body as {
		repertoireId: number;
		moves: MoveInput[];
		replacements: MoveInput[];
	};

	if (typeof repertoireId !== 'number') throw error(400, 'repertoireId must be a number');
	if (!Array.isArray(moves) || moves.length === 0) throw error(400, 'moves array is required');
	if (!Array.isArray(replacements)) throw error(400, 'replacements must be an array');

	// Verify repertoire ownership
	const [rep] = await db
		.select()
		.from(repertoire)
		.where(and(eq(repertoire.id, repertoireId), eq(repertoire.userId, user.id)));
	if (!rep) throw error(404, 'Repertoire not found');

	const repColor = rep.color as 'WHITE' | 'BLACK';

	// Build a set of replacement fenKeys for quick lookup
	const replacementSet = new Set<string>();
	for (const r of replacements) {
		replacementSet.add(fenKey(r.fromFen) + '|' + r.san);
	}

	// Validate all moves upfront and compute toFen for each
	const validatedMoves: {
		fromFen: string;
		toFen: string;
		san: string;
		isUserTurn: boolean;
		notes: string | null;
	}[] = [];

	for (const m of moves) {
		if (!m.fromFen || typeof m.fromFen !== 'string') continue;
		if (!m.san || typeof m.san !== 'string') continue;

		try {
			const chess = new Chess(m.fromFen);
			const fenTurn = chess.turn();
			const isUserTurn =
				(repColor === 'WHITE' && fenTurn === 'w') || (repColor === 'BLACK' && fenTurn === 'b');

			const result = chess.move(m.san);
			if (!result) continue;

			// Truncate annotation to 500 chars (matches existing notes limit)
			const raw = m.annotation;
			const notes = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 500) : null;

			validatedMoves.push({
				fromFen: fenKey(m.fromFen),
				toFen: fenKey(chess.fen()),
				san: result.san, // normalized SAN from Chess.js
				isUserTurn,
				notes
			});
		} catch {
			// Skip invalid moves silently — they were already flagged during parse
			continue;
		}
	}

	if (validatedMoves.length === 0) {
		throw error(400, 'No valid moves to import');
	}

	// Single transaction for all writes
	const result = await db.transaction(async (tx) => {
		// Serialise with every other writer of this repertoire: what is stored is read
		// below, and must not change under this import.
		if (!(await lockRepertoire(tx, repertoireId))) throw error(404, 'Repertoire not found');

		let inserted = 0;
		let replaced = 0;
		let skipped = 0;

		// A move is only written when its position is reachable from the starting
		// position through the repertoire as it will stand after the import. The
		// client sends every new move of the PGN, including the continuations of
		// moves the user refused in a conflict; those must not be stored, they
		// would hang off a position nothing leads to.
		//
		// The list is not guaranteed to be in tree order (resolved conflicts are
		// appended last), so it is processed in passes: each pass handles the moves
		// whose position is reachable at that point and defers the others. A pass
		// that handles nothing ends the loop, and what is left is unreachable.
		let edges = await loadEdges(tx, repertoireId);
		let reachable = computeReachable(edges);
		let pending = validatedMoves;
		let progress = true;

		while (pending.length > 0 && progress) {
			progress = false;
			const deferred: typeof validatedMoves = [];

			for (const vm of pending) {
				if (!reachable.has(vm.fromFen)) {
					deferred.push(vm);
					continue;
				}
				progress = true;

				if (vm.isUserTurn) {
					// Check for existing move at this position
					const [existing] = await tx
						.select()
						.from(userMove)
						.where(and(eq(userMove.repertoireId, repertoireId), eq(userMove.fromFen, vm.fromFen)));

					if (existing) {
						if (existing.san === vm.san) {
							// Exact same move — skip (idempotent)
							skipped++;
							reachable.add(vm.toFen);
							continue;
						}

						// Different move exists — check if user chose to replace it
						const replaceKey = fenKey(vm.fromFen) + '|' + vm.san;
						if (replacementSet.has(replaceKey)) {
							// User chose this PGN move over the existing one. It gets a fresh
							// drill card and the PGN's note (or none), and the lines only the old
							// move led to are removed; lines reachable another way are kept.
							await replaceUserMove(tx, user.id, repertoireId, {
								moveId: existing.id,
								fromFen: vm.fromFen,
								oldSan: existing.san,
								newSan: vm.san,
								newToFen: vm.toFen,
								source: 'PGN_IMPORT',
								notes: vm.notes,
								startFen: rep.startFen,
								now: new Date()
							});

							replaced++;

							// The deleted subtree may have been part of the reachable set:
							// recompute it from what is now stored.
							edges = await loadEdges(tx, repertoireId);
							reachable = computeReachable(edges);
						} else {
							// Not in replacements — keep existing (safety default). The
							// PGN move is not stored, so its position is not reachable
							// through it and its continuations will be left out.
							skipped++;
						}
						continue;
					}

					// No existing move — insert new move + SR card
					await tx.insert(userMove).values({
						userId: user.id,
						repertoireId,
						fromFen: vm.fromFen,
						toFen: vm.toFen,
						san: vm.san,
						source: 'PGN_IMPORT',
						notes: vm.notes,
						createdAt: new Date()
					});

					await tx.insert(userRepertoireMove).values({
						userId: user.id,
						repertoireId,
						fromFen: vm.fromFen,
						san: vm.san,
						due: new Date(),
						state: 0, // New
						reps: 0,
						lapses: 0,
						stability: null,
						difficulty: null,
						elapsedDays: null,
						scheduledDays: null,
						lastReview: null,
						learningSteps: 0
					});

					inserted++;
					reachable.add(vm.toFen);
				} else {
					// Opponent's turn — multiple moves allowed, no SR card
					const [existing] = await tx
						.select()
						.from(userMove)
						.where(
							and(
								eq(userMove.repertoireId, repertoireId),
								eq(userMove.fromFen, vm.fromFen),
								eq(userMove.san, vm.san)
							)
						);

					if (existing) {
						skipped++;
						reachable.add(vm.toFen);
						continue;
					}

					await tx.insert(userMove).values({
						userId: user.id,
						repertoireId,
						fromFen: vm.fromFen,
						toFen: vm.toFen,
						san: vm.san,
						source: 'PGN_IMPORT',
						notes: vm.notes,
						createdAt: new Date()
					});

					inserted++;
					reachable.add(vm.toFen);
				}
			}

			pending = deferred;
		}

		return { inserted, replaced, skipped, unreachable: pending.length };
	});

	return json(result);
};
