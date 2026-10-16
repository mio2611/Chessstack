// Client-side anti-gaffe scan: walks a game's fenHistory (via evaluateGame,
// the same sequential client-Stockfish loop review's CPL batch uses) and
// POSTs one candidate per user move where the eval swung by >=100cp from a
// position that wasn't already decided (eval before within [-300,+300]).
// The server (POST /api/anti-gaffe/candidates) re-validates and recomputes
// cp_loss independently — this file's own thresholds are a pre-filter to
// avoid posting requests that would just be rejected, not the source of
// truth.
//
// Written progressively: one candidate posted as soon as it's found, not
// batched at the end — a scan can legitimately run for many minutes (depth
// 20, no time cap, see $lib/client/stockfish), so an interrupted session
// shouldn't lose what it already found.
//
// A game is only marked as scanned (POST /api/anti-gaffe/scan-complete) when
// every position was evaluated at full depth AND every write succeeded. If
// the engine fails on any position (load error, crash, watchdog timeout,
// shallow partial result), the scan stops, nothing is marked, and the
// outcome is 'failed' so the caller can say so and let the user retry. If a
// write fails (network error or any non-2xx answer, for a candidate or for
// the scan-complete marker), nothing is marked either and the outcome is
// 'save-failed'. Candidates already posted stay (they are idempotent per
// game and ply, see the POST handler).

import { evaluateGame, type EvalGameProgress, type PositionEval } from './gameEval';

const MIN_CP_LOSS = 100;
const EVAL_WINDOW = 300;

export type AntiGaffeScanOutcome = 'complete' | 'cancelled' | 'failed' | 'save-failed';

export interface AntiGaffeScanOptions {
	gameSource: 'imported' | 'reviewed';
	gameId: number;
	fenHistory: string[];
	sanHistory: string[]; // sanHistory[i] is the move played from fenHistory[i] to fenHistory[i+1]
	playerColor: 'WHITE' | 'BLACK';
	onProgress?: (progress: EvalGameProgress) => void;
	/** Called once a found candidate has been saved (its POST succeeded), so a reload triggered from here sees it — for live UI feedback. */
	onCandidateFound?: (ply: number) => void;
	isCancelled?: () => boolean;
}

/**
 * True only if the server accepted the candidate (2xx). fetch does not
 * reject on 4xx/5xx, so the status has to be read: a lost candidate must
 * not go unnoticed. The scan carries on after a failed write (the remaining
 * positions are still worth evaluating) but will not be marked as scanned.
 */
async function postCandidate(payload: Record<string, unknown>): Promise<boolean> {
	try {
		const res = await fetch('/api/anti-gaffe/candidates', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** True only if the server recorded the scanned_at marker (2xx). */
async function markScanComplete(gameSource: string, gameId: number): Promise<boolean> {
	try {
		const res = await fetch('/api/anti-gaffe/scan-complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ gameSource, gameId })
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function scanGameForAntiGaffe(
	options: AntiGaffeScanOptions
): Promise<AntiGaffeScanOutcome> {
	const {
		gameSource,
		gameId,
		fenHistory,
		sanHistory,
		playerColor,
		onProgress,
		onCandidateFound,
		isCancelled
	} = options;

	const evals: (PositionEval | null)[] = new Array(fenHistory.length).fill(null);
	// One entry per candidate POST, resolved to whether it was saved.
	const saves: Promise<boolean>[] = [];
	// sanHistory[0] is always White's first move (fenHistory[0] is always
	// the standard starting position in this app — no Chess960/custom
	// starting FEN support), so move-index parity reliably tells us whose
	// move it was without re-parsing the FEN.
	const userMoveParity = playerColor === 'WHITE' ? 0 : 1;

	const summary = await evaluateGame(fenHistory, {
		isCancelled,
		onProgress,
		stopOnFailure: true,
		onResult: (ply, _fen, result) => {
			// A partial (shallower) evaluation is not trusted: it would be
			// compared as if it were depth 20 and could post a false candidate.
			evals[ply] = result?.completed ? result : null;

			// The move that was just fully evaluated (both endpoints known) is
			// the one from fenHistory[ply-1] to fenHistory[ply].
			const moveIndex = ply - 1;
			if (moveIndex < 0) return;
			if (moveIndex % 2 !== userMoveParity) return; // not the user's move

			const before = evals[moveIndex];
			const after = evals[ply];
			if (!before || !after || before.evalCp == null || after.evalCp == null) return;
			if (Math.abs(before.evalCp) > EVAL_WINDOW) return;

			const mover = moveIndex % 2 === 0 ? 'w' : 'b';
			const cpLoss = mover === 'w' ? before.evalCp - after.evalCp : after.evalCp - before.evalCp;
			if (cpLoss < MIN_CP_LOSS) return;

			saves.push(
				postCandidate({
					gameSource,
					gameId,
					ply: moveIndex,
					fen: fenHistory[moveIndex],
					playedSan: sanHistory[moveIndex],
					evalBeforeCp: before.evalCp,
					evalAfterCp: after.evalCp,
					bestMoveUci: before.bestMoveUci,
					bestMoveSan: before.bestMoveSan
				}).then((saved) => {
					// Only once saved: a reload triggered from here would
					// otherwise race the POST and miss this candidate.
					if (saved) onCandidateFound?.(moveIndex);
					return saved;
				})
			);
		}
	});

	// Wait for every write before deciding anything, cancelled runs
	// included: the caller reloads the list as soon as this returns and
	// must see every candidate that was found.
	const allSaved = (await Promise.all(saves)).every(Boolean);

	if (summary.cancelled || isCancelled?.()) return 'cancelled';
	if (summary.failures > 0) return 'failed';
	if (!allSaved) return 'save-failed';
	if (!(await markScanComplete(gameSource, gameId))) return 'save-failed';
	return 'complete';
}
