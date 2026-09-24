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

import { evaluateGame, type EvalGameProgress, type PositionEval } from './gameEval';

const MIN_CP_LOSS = 100;
const EVAL_WINDOW = 300;

export interface AntiGaffeScanOptions {
	gameSource: 'imported' | 'reviewed';
	gameId: number;
	fenHistory: string[];
	sanHistory: string[]; // sanHistory[i] is the move played from fenHistory[i] to fenHistory[i+1]
	playerColor: 'WHITE' | 'BLACK';
	onProgress?: (progress: EvalGameProgress) => void;
	/** Called synchronously the moment a candidate is found, before the POST resolves — for live UI feedback. */
	onCandidateFound?: (ply: number) => void;
	isCancelled?: () => boolean;
}

async function postCandidate(payload: Record<string, unknown>): Promise<void> {
	try {
		await fetch('/api/anti-gaffe/candidates', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
	} catch {
		// Network hiccup — this one candidate is lost, but the scan carries
		// on; nothing here is precious enough to abort the whole scan over
		// a single failed write.
	}
}

async function markScanComplete(gameSource: string, gameId: number): Promise<void> {
	try {
		await fetch('/api/anti-gaffe/scan-complete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ gameSource, gameId })
		});
	} catch {
		/* best-effort — a missed scanned_at marker just means the badge
		   stays "not scanned" and the user can retry */
	}
}

export async function scanGameForAntiGaffe(options: AntiGaffeScanOptions): Promise<void> {
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
	// sanHistory[0] is always White's first move (fenHistory[0] is always
	// the standard starting position in this app — no Chess960/custom
	// starting FEN support), so move-index parity reliably tells us whose
	// move it was without re-parsing the FEN.
	const userMoveParity = playerColor === 'WHITE' ? 0 : 1;

	await evaluateGame(fenHistory, {
		isCancelled,
		onProgress,
		onResult: (ply, _fen, result) => {
			evals[ply] = result;

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

			onCandidateFound?.(moveIndex);
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
			});
		}
	});

	if (isCancelled?.()) return;
	await markScanComplete(gameSource, gameId);
}
