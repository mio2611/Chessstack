// Sequential fenHistory evaluation loop, shared between review's CPL batch
// (runClientAnalysis in review/+page.svelte) and the anti-gaffe scan
// ($lib/client/antiGaffeScan.ts). Extracted here rather than duplicated —
// both need the exact same thing: walk every position in a game, one at a
// time, flip each raw (side-to-move-perspective) engine result to White's
// perspective, and support cancellation via a caller-supplied predicate so
// a superseded run stops issuing new positions without leaving a queued
// backlog behind it (see $lib/client/stockfish's own internal queue).

import { Chess } from 'chess.js';
import { evaluatePosition, type EvalResult } from './stockfish';

export interface PositionEval {
	/** White-perspective, like the old server convention. */
	evalCp: number | null;
	/** White-perspective. Always 0 (never signed) for a checkmate position: see checkmated. */
	evalMate: number | null;
	/**
	 * Set only for a checkmate position: the colour that is checkmated (the side
	 * to move). "Mate in 0" carries no sign, so this is the only way to tell
	 * which side won; use it, never the sign of evalMate, for that position.
	 */
	checkmated: 'w' | 'b' | null;
	/** Not perspective-flipped — a move is a move regardless of who's to move. */
	bestMoveUci: string | null;
	bestMoveSan: string | null;
	/**
	 * False when the engine's watchdog fired before the target depth: the
	 * values above are then a partial, shallower evaluation. Always true for
	 * a checkmate or stalemate position, which the engine reports at depth 0
	 * (nothing deeper exists to search).
	 */
	completed: boolean;
}

export interface EvalGameProgress {
	done: number;
	total: number;
}

export interface EvaluateGameOptions {
	/** Called once per position, in order, including failures (result: null). */
	onResult: (ply: number, fen: string, result: PositionEval | null) => void;
	onProgress?: (progress: EvalGameProgress) => void;
	/** Checked before AND after each awaited engine call. */
	isCancelled?: () => boolean;
	/** Stop at the first failed position instead of evaluating the rest of the game. */
	stopOnFailure?: boolean;
}

export interface EvaluateGameSummary {
	/** Positions that threw or came back incomplete (checkmate and stalemate positions excluded). */
	failures: number;
	/** True if isCancelled ended the loop before every position was evaluated. */
	cancelled: boolean;
}

/**
 * Converts a raw engine result (side-to-move perspective) to a PositionEval
 * (White perspective). Shared by evaluateGame and by one-off evaluations in
 * review, so the perspective flip and the checkmate/stalemate rules live in
 * one place.
 *
 * A checkmate or stalemate position is reported by the engine at depth 0
 * (nothing deeper exists to search), which is its complete answer. For a
 * checkmate the engine's "mate 0" is relative to the side to move and flipping
 * it cannot keep a sign, so the mated colour is recorded in `checkmated`.
 */
export function toPositionEval(fen: string, raw: EvalResult): PositionEval {
	const sideToMove = fen.split(' ')[1] === 'b' ? 'b' : 'w';
	const whiteMultiplier = sideToMove === 'w' ? 1 : -1;

	let checkmate = false;
	let stalemate = false;
	try {
		const chess = new Chess(fen);
		checkmate = chess.isCheckmate();
		stalemate = !checkmate && chess.isStalemate();
	} catch {
		// Unparseable FEN: treated as an ordinary position.
	}

	if (checkmate) {
		return {
			evalCp: null,
			evalMate: 0,
			checkmated: sideToMove,
			bestMoveUci: null,
			bestMoveSan: null,
			completed: true
		};
	}

	return {
		evalCp: raw.evalCp != null ? raw.evalCp * whiteMultiplier : null,
		evalMate: raw.evalMate != null ? raw.evalMate * whiteMultiplier : null,
		checkmated: null,
		bestMoveUci: raw.bestMoveUci,
		bestMoveSan: raw.bestMoveSan,
		completed: raw.completed || stalemate
	};
}

export async function evaluateGame(
	fenHistory: string[],
	{ onResult, onProgress, isCancelled, stopOnFailure }: EvaluateGameOptions
): Promise<EvaluateGameSummary> {
	let failures = 0;

	for (let i = 0; i < fenHistory.length; i++) {
		if (isCancelled?.()) return { failures, cancelled: true };

		const fen = fenHistory[i];
		let result: PositionEval | null = null;
		try {
			const raw = await evaluatePosition(fen);
			if (isCancelled?.()) return { failures, cancelled: true };
			result = toPositionEval(fen, raw);
		} catch {
			// Engine failed to load, crashed, or timed out — result stays null.
			// Review leaves that ply uncolored; the anti-gaffe scan treats it as
			// a failure (see the summary) and does not mark the game as scanned.
		}

		const failed = !result || !result.completed;
		if (failed) failures++;

		onResult(i, fen, result);
		onProgress?.({ done: i + 1, total: fenHistory.length });

		if (failed && stopOnFailure) return { failures, cancelled: false };
	}

	return { failures, cancelled: false };
}
