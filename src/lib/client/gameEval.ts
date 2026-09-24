// Sequential fenHistory evaluation loop, shared between review's CPL batch
// (runClientAnalysis in review/+page.svelte) and the anti-gaffe scan
// ($lib/client/antiGaffeScan.ts). Extracted here rather than duplicated —
// both need the exact same thing: walk every position in a game, one at a
// time, flip each raw (side-to-move-perspective) engine result to White's
// perspective, and support cancellation via a caller-supplied predicate so
// a superseded run stops issuing new positions without leaving a queued
// backlog behind it (see $lib/client/stockfish's own internal queue).

import { evaluatePosition } from './stockfish';

export interface PositionEval {
	/** White-perspective, like the old server convention. */
	evalCp: number | null;
	/** White-perspective. */
	evalMate: number | null;
	/** Not perspective-flipped — a move is a move regardless of who's to move. */
	bestMoveUci: string | null;
	bestMoveSan: string | null;
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
}

export async function evaluateGame(
	fenHistory: string[],
	{ onResult, onProgress, isCancelled }: EvaluateGameOptions
): Promise<void> {
	for (let i = 0; i < fenHistory.length; i++) {
		if (isCancelled?.()) return;

		const fen = fenHistory[i];
		let result: PositionEval | null = null;
		try {
			const raw = await evaluatePosition(fen);
			if (isCancelled?.()) return;
			const whiteMultiplier = fen.split(' ')[1] === 'w' ? 1 : -1;
			result = {
				evalCp: raw.evalCp != null ? raw.evalCp * whiteMultiplier : null,
				evalMate: raw.evalMate != null ? raw.evalMate * whiteMultiplier : null,
				bestMoveUci: raw.bestMoveUci,
				bestMoveSan: raw.bestMoveSan
			};
		} catch {
			// Watchdog timeout or similar — result stays null, caller decides
			// what that means (review leaves that ply uncolored; the
			// anti-gaffe scan just skips any candidate pair touching it).
		}

		onResult(i, fen, result);
		onProgress?.({ done: i + 1, total: fenHistory.length });
	}
}
