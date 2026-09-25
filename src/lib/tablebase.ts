// Lichess tablebase API client — used to validate moves live during an
// endgame drill session against Syzygy WDL/DTZ/DTM data, and to pick the
// auto-played defending side's move.
//
// Called server-side only (see api/endgame/*), never from the browser —
// same convention as lichess.ts for opponent prep. Positions are filtered
// to 7 pieces or fewer at import time (scripts/endgame-import.py), so every
// FEN this module is asked about should be within tablebase coverage; an
// 'unknown' category means something outside that assumption, not a normal
// outcome, and is surfaced as such rather than silently treated as a pass.
//
// One fetch of the position BEFORE a move already contains, in its `moves`
// list, the resulting category/dtz/dtm for every legal move from that
// position — including whichever one gets played. Validating a move is
// therefore a single tablebase call (evaluatePosition(beforeFen) + look up
// the played move's uci in the result), not two.

const TABLEBASE_URL = 'https://tablebase.lichess.ovh/standard';

export class TablebaseApiError extends Error {
	constructor(
		message: string,
		public status?: number
	) {
		super(message);
		this.name = 'TablebaseApiError';
	}
}

export type TablebaseCategory =
	| 'win'
	| 'maybe-win'
	| 'cursed-win'
	| 'draw'
	| 'blessed-loss'
	| 'maybe-loss'
	| 'loss'
	| 'unknown';

export interface TablebaseMove {
	uci: string;
	san: string;
	category: TablebaseCategory;
	dtz: number | null;
	dtm: number | null;
	checkmate: boolean;
	stalemate: boolean;
}

export interface TablebaseResult {
	category: TablebaseCategory;
	dtz: number | null;
	dtm: number | null;
	moves: TablebaseMove[];
}

export async function evaluatePosition(fen: string): Promise<TablebaseResult> {
	let res: Response;
	try {
		res = await fetch(`${TABLEBASE_URL}?fen=${encodeURIComponent(fen)}`, {
			signal: AbortSignal.timeout(15_000)
		});
	} catch (err) {
		throw new TablebaseApiError(
			`Tablebase request failed: ${err instanceof Error ? err.message : String(err)}`
		);
	}
	if (!res.ok) {
		throw new TablebaseApiError(`Tablebase returned ${res.status}`, res.status);
	}
	const data = await res.json();
	return {
		category: (data.category ?? 'unknown') as TablebaseCategory,
		dtz: data.dtz ?? null,
		dtm: data.dtm ?? null,
		moves: (data.moves ?? []).map((m: Record<string, unknown>) => ({
			uci: m.uci,
			san: m.san,
			category: (m.category ?? 'unknown') as TablebaseCategory,
			dtz: (m.dtz as number | null) ?? null,
			dtm: (m.dtm as number | null) ?? null,
			checkmate: Boolean(m.checkmate),
			stalemate: Boolean(m.stalemate)
		}))
	};
}

// "How good this category is for whoever it describes" — the side to move
// in the specific position it was computed for.
const RANK: Record<TablebaseCategory, number> = {
	loss: 0,
	'maybe-loss': 1,
	'blessed-loss': 2,
	draw: 3,
	'cursed-win': 4,
	'maybe-win': 5,
	win: 6,
	unknown: -1
};

const MIRROR: Record<TablebaseCategory, TablebaseCategory> = {
	win: 'loss',
	'maybe-win': 'maybe-loss',
	'cursed-win': 'blessed-loss',
	draw: 'draw',
	'blessed-loss': 'cursed-win',
	'maybe-loss': 'maybe-win',
	loss: 'win',
	unknown: 'unknown'
};

/**
 * Did a move preserve the WDL result class? `beforeCategory` is the mover's
 * standing before the move; `afterCategory` is the resulting position's
 * category, which — since it's now the opponent's move — is from the
 * opponent's frame, not the mover's. It has to be mirrored back into the
 * mover's frame before comparing ranks; comparing the two raw categories
 * directly (without this mirror step) silently accepts moves that hand the
 * game away — verified against a real API response during development,
 * where a queen move that turned a forced mate into a draw was wrongly
 * accepted as sound without this correction.
 */
export function categoryPreserved(
	beforeCategory: TablebaseCategory,
	afterCategory: TablebaseCategory
): boolean {
	if (beforeCategory === 'unknown' || afterCategory === 'unknown') return false;
	const impliedMoverCategoryAfter = MIRROR[afterCategory];
	return RANK[impliedMoverCategoryAfter] >= RANK[beforeCategory];
}

export interface MoveEvaluation {
	found: boolean;
	sound: boolean;
	optimal: boolean;
	positionCategory: TablebaseCategory;
	positionDtz: number | null;
	positionDtm: number | null;
	move: TablebaseMove | null;
	// The best sound move available at this position, regardless of which
	// move was actually played — used by Theory mode to reveal the correct
	// move after repeated failed attempts, so the drill can't stall forever
	// on a move the user can't find.
	bestMove: TablebaseMove | null;
}

/**
 * Evaluates a single move played at `fen` (identified by its UCI, e.g.
 * "e2e4") using one tablebase call. `optimal` is true if the move's
 * resulting dtz ties the best available among moves that also preserve the
 * result class — the "exact fastest/safest line" check Theory mode needs;
 * Practice mode only cares about `sound`.
 */
export async function evaluateMove(fen: string, uci: string): Promise<MoveEvaluation> {
	const position = await evaluatePosition(fen);
	const move = position.moves.find((m) => m.uci === uci) ?? null;

	const soundMoves = position.moves.filter((m) => categoryPreserved(position.category, m.category));
	const bestMove =
		soundMoves.length > 0
			? soundMoves.reduce((best, m) =>
					Math.abs(m.dtz ?? Infinity) < Math.abs(best.dtz ?? Infinity) ? m : best
				)
			: null;

	if (!move) {
		return {
			found: false,
			sound: false,
			optimal: false,
			positionCategory: position.category,
			positionDtz: position.dtz,
			positionDtm: position.dtm,
			move: null,
			bestMove
		};
	}

	const sound = categoryPreserved(position.category, move.category);
	const optimal =
		sound &&
		bestMove !== null &&
		Math.abs(move.dtz ?? Infinity) === Math.abs(bestMove.dtz ?? Infinity);

	return {
		found: true,
		sound,
		optimal,
		positionCategory: position.category,
		positionDtz: position.dtz,
		positionDtm: position.dtm,
		move,
		bestMove
	};
}

/**
 * Picks the defending side's move at `fen` (their turn) that leaves the
 * opponent (the drill's user, i.e. whoever moves next) worst off — i.e. the
 * strongest defense the tablebase can find. Among moves tied on category,
 * prefers the one with the largest |dtz|, a natural-play heuristic (delay
 * the outcome as long as possible) — not a substitute for the more
 * human-like defense a real engine like Stockfish could give (the
 * simplification here relative to what a Stockfish-assisted tool like
 * chesstempo does at this piece count). Returns null if there are no legal
 * moves (checkmate/stalemate already) or the position is outside tablebase
 * coverage.
 */
export async function pickBestDefense(fen: string): Promise<TablebaseMove | null> {
	const position = await evaluatePosition(fen);
	const candidates = position.moves.filter((m) => m.category !== 'unknown');
	if (candidates.length === 0) return null;
	const ranked = [...candidates].sort((a, b) => {
		const rankDiff = RANK[a.category] - RANK[b.category];
		if (rankDiff !== 0) return rankDiff;
		return Math.abs(b.dtz ?? 0) - Math.abs(a.dtz ?? 0);
	});
	return ranked[0] ?? null;
}
