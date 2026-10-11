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
	/** Only set by evaluatePositionBackground: the search was stopped on purpose (preempted or cancelled), not by the watchdog. */
	interrupted?: boolean;
}

let worker: Worker | null = null;
let readyPromise: Promise<void> | null = null;

// Serialises calls: the engine can only run one search at a time. Each new
// call waits for the previous one to settle (success or failure) before
// starting its own search.
let queue: Promise<unknown> = Promise.resolve();

// Opt-in cancellation for interactive callers only (the Build/Review
// engine tab, via evaluatePositionMultiPv's `interactive` flag) that may
// issue a new request before the previous one has resolved — one person
// clicking through several positions in the tree faster than a depth-20
// search completes.
//
// Deliberately entirely separate from — and invisible to — non-interactive
// calls (the anti-gaffe scan, CPL review, evaluatePosition): those never
// call nextInteractiveRequestId, so they are never superseded and never
// send 'stop' to interrupt anyone else's search. An interactive call only
// ever cancels another *interactive* call, never a batch one — if an
// interactive request happens to be queued behind an active batch search,
// it simply waits its turn like before, it does not cut the batch search
// short. That keeps a cancelled interactive search from ever being the
// thing a batch caller (e.g. review's anti-gaffe MultiPV cache) persists
// as if it were a complete depth-20 result.
let latestInteractiveRequestId = 0;
let activeInteractiveRequestId: number | null = null;

function nextInteractiveRequestId(): number {
	const id = ++latestInteractiveRequestId;
	if (activeInteractiveRequestId !== null && activeInteractiveRequestId !== id) {
		getWorker().postMessage('stop');
	}
	return id;
}

// ── Background searches (child-move evals for the Players tab) ───────────
// Lowest priority: they never supersede anything, and any foreground call
// (every evaluatePosition / evaluatePositionMultiPv call, interactive or
// batch) or an explicit stopBackgroundSearch interrupts them. An
// interrupted background search resolves with completed: false and
// interrupted: true so the caller can tell "preempted, retry later" from a
// watchdog failure.
//
// A background search is never anybody's watched result, so cutting it
// short is safe for batch callers too: unlike an interactive search, it is
// never something a batch caller persists as a complete depth-20 result.
let backgroundRunning = false;
let backgroundStopRequested = false;

// Bumped by every stopBackgroundSearch(). A background call captures the
// value when it is made and gives up as soon as it changes, which covers
// the window where the stop finds nothing to interrupt: the call is still
// waiting in the queue, or the engine is still initializing.
let backgroundEpoch = 0;

/** Stop the background search that is running right now, if any, and abandon any that is queued. */
export function stopBackgroundSearch(): void {
	backgroundEpoch++;
	if (!backgroundRunning) return;
	backgroundStopRequested = true;
	getWorker().postMessage('stop');
}

// Number of foreground calls (interactive or batch) issued but not yet
// settled. Background callers await whenInteractiveIdle() before
// enqueueing, so they never queue ahead of a search somebody is waiting on.
let foregroundInFlight = 0;
let idleWaiters: Array<() => void> = [];

function foregroundStarted(): void {
	foregroundInFlight++;
	// A foreground call outranks any background search: cut it short so
	// this call does not wait for a depth-20 search nobody is looking at.
	stopBackgroundSearch();
}

function foregroundSettled(): void {
	foregroundInFlight--;
	if (foregroundInFlight === 0) {
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const resolve of waiters) resolve();
	}
}

/** Resolves once no foreground search (interactive or batch) is pending or running. */
export async function whenInteractiveIdle(): Promise<void> {
	// Re-checked after every wake-up: a foreground call issued in the same
	// tick as the last one settling (e.g. the next position of a batch
	// scan) must not be overtaken by the caller that was waiting.
	while (foregroundInFlight > 0) {
		await new Promise<void>((resolve) => idleWaiters.push(resolve));
	}
}

/** True if a newer interactive call has been made since this one started waiting in the queue — this call's result is stale and should not touch the engine. */
function isInteractiveSuperseded(requestId: number): boolean {
	return requestId !== latestInteractiveRequestId;
}

/**
 * Stops the interactive (Engine tab) search in progress, if any, and makes
 * any queued interactive call resolve empty without searching. For a caller
 * that answers a position from its own cache and so issues no interactive
 * call: without this, the search of the position just left would keep
 * running to the target depth for nothing. Does not touch background
 * searches (the Players / Masters coloring), which must keep going.
 */
export function cancelInteractiveSearches(): void {
	nextInteractiveRequestId();
}

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
	return evaluatePositionInternal(fen, onProgress, null);
}

/**
 * Same search as evaluatePosition, at the lowest priority. Meant for
 * speculative evals (Players tab child moves): `isCancelled` is checked
 * before the search starts, and stopBackgroundSearch() or any foreground
 * call (interactive or batch) interrupts it, including while it is still
 * queued or the engine is initializing (result: completed false,
 * interrupted true). Callers should await whenInteractiveIdle() first so
 * they do not queue ahead of a foreground search.
 */
export function evaluatePositionBackground(
	fen: string,
	isCancelled: () => boolean
): Promise<EvalResult> {
	return evaluatePositionInternal(fen, undefined, isCancelled);
}

function evaluatePositionInternal(
	fen: string,
	onProgress: ((p: EvalProgress) => void) | undefined,
	isCancelled: (() => boolean) | null
): Promise<EvalResult> {
	const background = isCancelled !== null;
	// See backgroundEpoch: captured now, at call time.
	const epoch = backgroundEpoch;
	const shouldAbort = (): boolean =>
		background && (epoch !== backgroundEpoch || (isCancelled?.() ?? false));
	if (!background) foregroundStarted();
	const interruptedResult: EvalResult = {
		evalCp: null,
		evalMate: null,
		bestMoveUci: null,
		bestMoveSan: null,
		depthReached: 0,
		completed: false,
		interrupted: true
	};

	const run = async (): Promise<EvalResult> => {
		if (shouldAbort()) return interruptedResult;

		const w = getWorker();
		if (!readyPromise) readyPromise = ensureReady(w);
		await readyPromise;

		if (background) {
			// A stop requested while this call was queued or the engine was
			// initializing found nothing to interrupt (backgroundRunning was
			// still false): check again before claiming the engine.
			if (shouldAbort()) return interruptedResult;
			backgroundRunning = true;
			backgroundStopRequested = false;
		}

		let evalCp: number | null = null;
		let evalMate: number | null = null;
		let depthReached = 0;

		// See resetForNewSearch's comment: without this, the hash table
		// carries over stale entries from whatever was searched before,
		// producing a different score/bestmove for a nominally identical
		// depth-20 search depending purely on evaluation order.
		try {
			await resetForNewSearch(w, 1);
			w.postMessage(`position fen ${fen}`);
			w.postMessage(`go depth ${TARGET_DEPTH}`);
			// A stop requested while we were still in resetForNewSearch was
			// ignored by the engine (nothing was searching yet): repeat it.
			if (background && (backgroundStopRequested || shouldAbort())) {
				backgroundStopRequested = true;
				w.postMessage('stop');
			}

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

			const completed = depthReached >= TARGET_DEPTH;
			return {
				evalCp,
				evalMate,
				bestMoveUci,
				bestMoveSan: bestMoveUci ? uciToSan(fen, bestMoveUci) : null,
				depthReached,
				completed,
				...(background ? { interrupted: !completed && backgroundStopRequested } : {})
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
		} finally {
			if (background) {
				backgroundRunning = false;
				backgroundStopRequested = false;
			}
		}
	};

	const result = queue.then(run, run);
	// Swallow so a failed evaluation doesn't poison the queue for the next call.
	queue = result.catch(() => undefined);
	if (!background) result.then(foregroundSettled, foregroundSettled);
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
 *
 * Pass `interactive: true` for callers where a newer call can supersede an
 * older, still-running one — e.g. the Build/Review engine tab, where the
 * user may move to a new position before the previous depth-20 search
 * finishes. See nextInteractiveRequestId's comment for the exact
 * semantics. Leave it false (the default) for sequential/batch callers
 * such as review's anti-gaffe MultiPV lookup, which always awaits one call
 * before issuing the next and must never have its search cut short by an
 * unrelated interactive caller — this flag is what keeps the two fully
 * decoupled.
 */
export function evaluatePositionMultiPv(
	fen: string,
	lines: number,
	onProgress?: (p: EvalProgress) => void,
	interactive = false
): Promise<MultiPvLine[]> {
	const requestId = interactive ? nextInteractiveRequestId() : null;
	foregroundStarted();

	const run = async (): Promise<MultiPvLine[]> => {
		if (requestId !== null && isInteractiveSuperseded(requestId)) return [];

		const w = getWorker();
		if (!readyPromise) readyPromise = ensureReady(w);
		await readyPromise;

		// slot (1-indexed, per UCI's "multipv N") → latest line seen for it.
		const slots = new Map<number, MultiPvLine>();
		let depthReached = 0;

		await resetForNewSearch(w, lines);
		w.postMessage(`position fen ${fen}`);
		w.postMessage(`go depth ${TARGET_DEPTH}`);
		if (requestId !== null) activeInteractiveRequestId = requestId;

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
		} finally {
			if (requestId !== null && activeInteractiveRequestId === requestId) {
				activeInteractiveRequestId = null;
			}
		}
	};

	const result = queue.then(run, run);
	queue = result.catch(() => undefined);
	result.then(foregroundSettled, foregroundSettled);
	return result;
}
