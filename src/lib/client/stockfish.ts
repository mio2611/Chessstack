// Client-side Stockfish engine — runs entirely in the browser via a
// persistent Web Worker, no server round-trip and no NAS CPU ceiling.
//
// Deliberately the "lite, single-threaded" WASM build (~1.6MB, no
// Cross-Origin-Opener/Embedder-Policy headers required), not the "large"
// (~94MB) or multi-threaded builds — see project notes for the tradeoff.
// The engine file itself is not committed to git: scripts/copy-engine-assets.js
// copies it from node_modules/stockfish/bin into static/engine/ on every
// build (see the "prebuild" script in package.json).
//
// Target depth is fixed at 20, with NO time cap — a position can
// legitimately take 30s or more on a slower machine, and that is accepted
// by design. The only safety net is the watchdog below: if the engine goes
// WATCHDOG_MS without emitting a single depth-progress line, the search is
// treated as failed (engine hang/crash) rather than waited on forever.
//
// Every search sends ucinewgame first — see resetForNewSearch's comment.
// Without it, the hash table carries over between unrelated positions
// evaluated in the same session, and a nominally identical depth-20 search
// can silently produce a different score and a different best move
// depending purely on what was evaluated beforehand. Confirmed by direct
// testing against native Stockfish before this was added.
//
// Perspective convention: evalCp/evalMate are returned RAW, from the
// perspective of the side to move in the given FEN (standard UCI
// convention) — this module does not flip to White's perspective. Callers
// that need a White-relative score (to match the existing server
// convention in $lib/stockfish/index.ts) must flip it themselves based on
// whose turn it was.

import { Chess } from 'chess.js';

export const TARGET_DEPTH = 20;

// No progress (no new "info depth" line) for this long ⇒ treat as a hung
// or crashed engine, not a legitimately slow search.
const WATCHDOG_MS = 3 * 60 * 1000;

const ENGINE_URL = '/engine/stockfish-19-lite-single.js';

export interface EvalProgress {
	depth: number;
}

export interface EvalResult {
	/** Raw score in centipawns, from the perspective of the side to move. Null if mate score applies instead. */
	evalCp: number | null;
	/** Mate-in-N, from the perspective of the side to move. Null if a centipawn score applies instead. */
	evalMate: number | null;
	/** Best move in UCI notation (e.g. "e2e4", "e7e8q"), or null if none (checkmate/stalemate/watchdog failure). */
	bestMoveUci: string | null;
	/** Same move in SAN (e.g. "e4", "exd5", "e8=Q"), derived via chess.js from the input FEN. Null if bestMoveUci is null or illegal for the given FEN. */
	bestMoveSan: string | null;
	/** Highest depth actually reached before the search ended. */
	depthReached: number;
	/** True if depthReached >= TARGET_DEPTH. False if the watchdog fired first. */
	completed: boolean;
}

let worker: Worker | null = null;
let readyPromise: Promise<void> | null = null;

// Serialises calls: the engine can only run one search at a time. Each new
// call waits for the previous one to settle (success or failure) before
// starting its own search.
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Worker {
	if (!worker) {
		worker = new Worker(ENGINE_URL);
	}
	return worker;
}

/**
 * Resolve when a line matching `isMatch` arrives. Calls `onLine` for every
 * line seen in the meantime (used to track "info depth" progress). Rejects
 * with a `stockfish-watchdog-timeout` error if WATCHDOG_MS elapses without
 * ANY line arriving — not just without a matching one — so a genuinely
 * slow-but-alive search is never mistaken for a hang.
 */
function waitFor(
	w: Worker,
	isMatch: (line: string) => boolean,
	onLine?: (line: string) => void
): Promise<string> {
	return new Promise((resolve, reject) => {
		let watchdog: ReturnType<typeof setTimeout>;

		function handleMessage(e: MessageEvent<string>) {
			const line = e.data;
			resetWatchdog();
			onLine?.(line);
			if (isMatch(line)) {
				cleanup();
				resolve(line);
			}
		}

		function resetWatchdog() {
			clearTimeout(watchdog);
			watchdog = setTimeout(() => {
				cleanup();
				reject(new Error('stockfish-watchdog-timeout'));
			}, WATCHDOG_MS);
		}

		function cleanup() {
			clearTimeout(watchdog);
			w.removeEventListener('message', handleMessage);
		}

		w.addEventListener('message', handleMessage);
		resetWatchdog();
	});
}

async function ensureReady(w: Worker): Promise<void> {
	w.postMessage('uci');
	await waitFor(w, (l) => l === 'uciok');
	w.postMessage('isready');
	await waitFor(w, (l) => l === 'readyok');
}

// Confirmed by direct testing against native Stockfish: without ucinewgame,
// the transposition hash table carries over between unrelated positions
// evaluated in the same session. Same FEN, same requested depth, genuinely
// different score AND different best move depending on what was evaluated
// beforehand — reproduced with a fresh engine vs. one that had searched 5
// unrelated positions first (score off by ~0.2 pawns, different bestmove,
// fewer nodes searched despite reaching the same nominal depth). Sent
// before every single search, with the isready/readyok round-trip the UCI
// protocol recommends after ucinewgame (the engine may need a moment to
// actually clear the table).
async function resetForNewSearch(w: Worker, multiPv: number): Promise<void> {
	w.postMessage('ucinewgame');
	w.postMessage(`setoption name MultiPV value ${multiPv}`);
	w.postMessage('isready');
	await waitFor(w, (l) => l === 'readyok');
}

const INFO_DEPTH_RE = /^info depth (\d+)/;
const SCORE_CP_RE = /score cp (-?\d+)/;
const SCORE_MATE_RE = /score mate (-?\d+)/;
const BESTMOVE_RE = /^bestmove (\S+)/;

/** Convert a UCI move (e.g. "e7e8q") to SAN, given the FEN it was played from. Returns null if illegal or "(none)". */
function uciToSan(fen: string, uciMove: string): string | null {
	if (!uciMove || uciMove === '(none)') return null;
	try {
		const chess = new Chess(fen);
		const from = uciMove.slice(0, 2);
		const to = uciMove.slice(2, 4);
		const promotion = uciMove.length > 4 ? uciMove.slice(4) : undefined;
		const move = chess.move({ from, to, promotion });
		return move?.san ?? null;
	} catch {
		return null;
	}
}

/**
 * Evaluate a single FEN at TARGET_DEPTH (fixed, no time cap). Calls run
 * one at a time on a single persistent worker — concurrent calls queue up
 * rather than fighting over the engine.
 *
 * On a watchdog timeout the engine is sent "stop" (so it does not keep
 * burning CPU on an abandoned search) and the result comes back with
 * completed: false and whatever depth/eval had already been reached, if
 * any.
 */
export function evaluatePosition(
	fen: string,
	onProgress?: (p: EvalProgress) => void
): Promise<EvalResult> {
	const run = async (): Promise<EvalResult> => {
		const w = getWorker();
		if (!readyPromise) readyPromise = ensureReady(w);
		await readyPromise;

		let evalCp: number | null = null;
		let evalMate: number | null = null;
		let depthReached = 0;

		// See resetForNewSearch's comment: without this, the hash table
		// carries over stale entries from whatever was searched before,
		// producing a different score/bestmove for a nominally identical
		// depth-20 search depending purely on evaluation order.
		await resetForNewSearch(w, 1);
		w.postMessage(`position fen ${fen}`);
		w.postMessage(`go depth ${TARGET_DEPTH}`);

		try {
			const bestmoveLine = await waitFor(
				w,
				(l) => BESTMOVE_RE.test(l),
				(line) => {
					const depthMatch = INFO_DEPTH_RE.exec(line);
					if (!depthMatch) return;

					depthReached = parseInt(depthMatch[1], 10);
					onProgress?.({ depth: depthReached });

					const cpMatch = SCORE_CP_RE.exec(line);
					const mateMatch = SCORE_MATE_RE.exec(line);
					if (cpMatch) {
						evalCp = parseInt(cpMatch[1], 10);
						evalMate = null;
					} else if (mateMatch) {
						evalMate = parseInt(mateMatch[1], 10);
						evalCp = null;
					}
				}
			);

			const bestMoveUci = BESTMOVE_RE.exec(bestmoveLine)?.[1] ?? null;

			return {
				evalCp,
				evalMate,
				bestMoveUci,
				bestMoveSan: bestMoveUci ? uciToSan(fen, bestMoveUci) : null,
				depthReached,
				completed: depthReached >= TARGET_DEPTH
			};
		} catch (err) {
			if (err instanceof Error && err.message === 'stockfish-watchdog-timeout') {
				// Stop the current search so it doesn't keep burning CPU on a
				// position we've given up waiting on.
				w.postMessage('stop');
				return {
					evalCp,
					evalMate,
					bestMoveUci: null,
					bestMoveSan: null,
					depthReached,
					completed: false
				};
			}
			throw err;
		}
	};

	const result = queue.then(run, run);
	// Swallow so a failed evaluation doesn't poison the queue for the next call.
	queue = result.catch(() => undefined);
	return result;
}

export interface MultiPvLine {
	/** Raw score in centipawns, from the perspective of the side to move. Null if mate score applies instead. */
	evalCp: number | null;
	evalMate: number | null;
	moveUci: string;
	moveSan: string | null;
}

const MULTIPV_RE = /multipv (\d+)/;
const PV_MOVE_RE = /\bpv (\S+)/;

/**
 * Like evaluatePosition, but asks the engine for the top `lines` moves
 * instead of just one — for showing candidates when a position is being
 * studied, not for the anti-gaffe scan itself (which only ever needs the
 * single best eval and stays on evaluatePosition/MultiPV 1, since MultiPV
 * search is slower per position and the scan already runs long enough).
 *
 * Same depth/watchdog/queue behaviour as evaluatePosition — see its own
 * comments. Returns fewer than `lines` entries if the position has fewer
 * legal moves than requested, or none at all on checkmate/stalemate.
 */
export function evaluatePositionMultiPv(
	fen: string,
	lines: number,
	onProgress?: (p: EvalProgress) => void
): Promise<MultiPvLine[]> {
	const run = async (): Promise<MultiPvLine[]> => {
		const w = getWorker();
		if (!readyPromise) readyPromise = ensureReady(w);
		await readyPromise;

		// slot (1-indexed, per UCI's "multipv N") → latest line seen for it.
		const slots = new Map<number, MultiPvLine>();
		let depthReached = 0;

		await resetForNewSearch(w, lines);
		w.postMessage(`position fen ${fen}`);
		w.postMessage(`go depth ${TARGET_DEPTH}`);

		try {
			await waitFor(
				w,
				(l) => BESTMOVE_RE.test(l),
				(line) => {
					const depthMatch = INFO_DEPTH_RE.exec(line);
					if (!depthMatch) return;
					depthReached = parseInt(depthMatch[1], 10);
					onProgress?.({ depth: depthReached });

					const multipvMatch = MULTIPV_RE.exec(line);
					const pvMatch = PV_MOVE_RE.exec(line);
					if (!multipvMatch || !pvMatch) return;
					const slot = parseInt(multipvMatch[1], 10);
					const moveUci = pvMatch[1];

					const cpMatch = SCORE_CP_RE.exec(line);
					const mateMatch = SCORE_MATE_RE.exec(line);
					slots.set(slot, {
						evalCp: cpMatch ? parseInt(cpMatch[1], 10) : null,
						evalMate: mateMatch ? parseInt(mateMatch[1], 10) : null,
						moveUci,
						moveSan: uciToSan(fen, moveUci)
					});
				}
			);

			return Array.from(slots.keys())
				.sort((a, b) => a - b)
				.map((slot) => slots.get(slot)!);
		} catch (err) {
			if (err instanceof Error && err.message === 'stockfish-watchdog-timeout') {
				w.postMessage('stop');
				return Array.from(slots.keys())
					.sort((a, b) => a - b)
					.map((slot) => slots.get(slot)!);
			}
			throw err;
		}
	};

	const result = queue.then(run, run);
	queue = result.catch(() => undefined);
	return result;
}
