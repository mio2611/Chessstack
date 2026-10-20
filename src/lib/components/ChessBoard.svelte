<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { Chessground } from '@lichess-org/chessground';
	import { Chess } from 'chess.js';
	import type { Square } from 'chess.js';
	import type { Api } from '@lichess-org/chessground/api';
	import type { Key } from '@lichess-org/chessground/types';
	import type { DrawShape } from '@lichess-org/chessground/draw';

	// Chessground base CSS (layout + positioning) is always needed.
	// Board square colors come from our generated theme CSS (class-scoped),
	// and the cburnett piece set is the default (piece set selection deferred).
	import '@lichess-org/chessground/assets/chessground.base.css';
	import '$lib/themes/board-themes.css';
	import '@lichess-org/chessground/assets/chessground.cburnett.css';

	// ---------------------------------------------------------------------------
	// Props
	// ---------------------------------------------------------------------------

	interface Props {
		/** FEN string for the position to display. Defaults to the starting position. */
		fen?: string;
		/** Which colour appears at the bottom of the board. */
		orientation?: 'white' | 'black';
		/** Board color theme name (matches a .board-theme-{name} CSS class). */
		boardTheme?: string;
		/**
		 * When true, the player whose turn it is can drag/click their pieces.
		 * Set to false during opponent auto-play in drill mode.
		 */
		interactive?: boolean;
		/**
		 * Highlight a move on the board (e.g. the last move played).
		 * Pass [fromSquare, toSquare], e.g. ['e2', 'e4'].
		 */
		lastMove?: [string, string];
		/**
		 * Called after the user makes a legal move.
		 * Receives the origin square, destination square, the SAN notation (e.g. "Nf3"),
		 * the new FEN after the move, whether a piece was captured (for sound selection),
		 * and the chosen piece ('q' | 'r' | 'b' | 'n') when the move is a promotion.
		 * For a promotion the callback fires only once the user has picked a piece.
		 */
		onMove?: (
			from: string,
			to: string,
			san: string,
			newFen: string,
			isCapture: boolean,
			promotion?: PromotionPiece
		) => void;
		/**
		 * Programmatic arrows/dots to draw on the board (e.g. repertoire move arrows
		 * in build mode). Uses Chessground's autoShapes — these are distinct from
		 * user-drawn right-click arrows. Defaults to an empty array (no shapes).
		 */
		autoShapes?: DrawShape[];
	}

	const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

	type PromotionPiece = 'q' | 'r' | 'b' | 'n';

	// Order of the chooser, nearest the board edge first (same as Lichess).
	const PROMOTION_CHOICES: { piece: PromotionPiece; role: string; label: string }[] = [
		{ piece: 'q', role: 'queen', label: 'Queen' },
		{ piece: 'n', role: 'knight', label: 'Knight' },
		{ piece: 'r', role: 'rook', label: 'Rook' },
		{ piece: 'b', role: 'bishop', label: 'Bishop' }
	];

	// A pawn has reached the last rank and the user has not yet picked a piece.
	// col/row are the destination square's position on screen (0 = top/left),
	// dir is the direction the chooser extends in (away from the board edge).
	interface PendingPromotion {
		orig: Key;
		dest: Key;
		color: 'white' | 'black';
		baseFen: string;
		col: number;
		row: number;
		dir: 1 | -1;
	}
	let pendingPromotion = $state<PendingPromotion | null>(null);

	let {
		fen = STARTING_FEN,
		orientation = 'white',
		boardTheme = 'brown',
		interactive = true,
		lastMove = undefined,
		onMove = undefined,
		autoShapes = []
	}: Props = $props();

	// ---------------------------------------------------------------------------
	// Internal state
	// ---------------------------------------------------------------------------

	// boardEl: the div that Chessground attaches its DOM tree into.
	// set by Svelte's bind:this once the div is in the DOM.
	let boardEl: HTMLElement;

	// The Chessground API handle — lets us call cg.set() to update the board later.
	let cg: Api | undefined;

	// A reactive flag that flips to true inside onMount once Chessground is ready.
	// The $effect below watches this so it knows when it is safe to call cg.set().
	let initialized = $state(false);

	// ---------------------------------------------------------------------------
	// Helper functions
	// ---------------------------------------------------------------------------

	/**
	 * Build the legal-move destinations map that Chessground uses to draw the
	 * green dots when a piece is selected.
	 *
	 * Returns a Map<fromSquare, toSquare[]>.  Chessground calls this the "dests"
	 * map.  We compute it from Chess.js because Chessground itself has no idea
	 * which moves are legal — it is purely a visual component.
	 *
	 * Deduplication: when a pawn can promote, Chess.js returns 4 separate moves
	 * (one per promotion piece) to the same destination square.  We deduplicate
	 * so Chessground only sees one destination per square.
	 */
	function buildDests(chess: Chess): Map<Key, Key[]> {
		const dests = new SvelteMap<Key, Key[]>();
		for (const move of chess.moves({ verbose: true })) {
			const from = move.from as Key;
			const to = move.to as Key;
			if (!dests.has(from)) dests.set(from, []);
			const arr = dests.get(from)!;
			// Only add the destination once (promotion generates duplicates)
			if (!arr.includes(to)) arr.push(to);
		}
		return dests;
	}

	/** Translate Chess.js 'w'/'b' to Chessground 'white'/'black'. */
	function toColor(chess: Chess): 'white' | 'black' {
		return chess.turn() === 'w' ? 'white' : 'black';
	}

	// ---------------------------------------------------------------------------
	// Move handler
	// ---------------------------------------------------------------------------

	/**
	 * Called by Chessground after the user drags or clicks a piece to a new square.
	 *
	 * At this point Chessground has already moved the piece visually.  Our job is to:
	 *   1. Validate the move through Chess.js (to get the SAN string and new FEN).
	 *   2. Update Chessground's legal-move map for the next turn.
	 *   3. Notify the parent component via the onMove callback.
	 *
	 * Note: reading `fen`, `interactive`, `onMove` here always gives the *current*
	 * values because they are Svelte 5 reactive props ($props), not stale closures.
	 */
	function handleAfterMove(orig: Key, dest: Key): void {
		const chess = new Chess(fen);
		// Cast to Square: Chessground's Key includes the sentinel 'a0', but after()
		// is only ever called with real board squares, so this cast is safe.
		const piece = chess.get(orig as Square);

		// Detect pawn promotion: pawn on the 7th rank moving to the 8th (white)
		// or pawn on 2nd rank moving to 1st (black).
		const isPromotion =
			piece?.type === 'p' &&
			((piece.color === 'w' && dest[1] === '8') || (piece.color === 'b' && dest[1] === '1'));

		if (isPromotion) {
			// Chessground already shows the pawn on the last rank. Freeze the board
			// and let the user pick the piece; the move is played in choosePromotion().
			const flipped = orientation === 'black';
			const file = dest.charCodeAt(0) - 97; // a..h -> 0..7
			const rank = Number(dest[1]);
			const row = flipped ? rank - 1 : 8 - rank;
			cg?.set({ movable: { color: undefined } });
			pendingPromotion = {
				orig,
				dest,
				color: piece.color === 'w' ? 'white' : 'black',
				baseFen: fen,
				col: flipped ? 7 - file : file,
				row,
				dir: row === 0 ? 1 : -1
			};
			return;
		}

		completeMove(orig, dest, undefined);
	}

	/** Play the move in Chess.js, sync the board and notify the parent. */
	function completeMove(orig: Key, dest: Key, promotion: PromotionPiece | undefined): void {
		const chess = new Chess(fen);
		const result = chess.move({
			from: orig as Square,
			to: dest as Square,
			promotion
		});

		if (!result) {
			// Should not happen because we pre-computed dests from Chess.js,
			// but snap the board back to the last known-good FEN just in case.
			cg?.set({ fen });
			return;
		}

		// Update the board's turn colour and legal-move map for the next ply.
		// After a promotion Chessground still shows the pawn, so redraw the pieces.
		cg?.set({
			...(promotion ? { fen: chess.fen() } : {}),
			turnColor: toColor(chess),
			movable: {
				color: interactive ? toColor(chess) : undefined,
				dests: interactive ? buildDests(chess) : new Map()
			}
		});

		// Tell the parent what happened. `result.captured` is set when a piece
		// was taken — pass it as a boolean so the parent can pick the right sound.
		onMove?.(orig, dest, result.san, chess.fen(), !!result.captured, promotion);
	}

	function choosePromotion(piece: PromotionPiece): void {
		const pending = pendingPromotion;
		if (!pending) return;
		pendingPromotion = null;
		if (pending.baseFen !== fen) return; // position changed under the chooser
		completeMove(pending.orig, pending.dest, piece);
	}

	/** Close the chooser without moving: put the pawn back and re-enable play. */
	function cancelPromotion(): void {
		if (!pendingPromotion) return;
		pendingPromotion = null;
		const chess = new Chess(fen);
		cg?.set({
			fen,
			turnColor: toColor(chess),
			lastMove: lastMove as [Key, Key] | undefined,
			movable: {
				color: interactive ? toColor(chess) : undefined,
				dests: interactive ? buildDests(chess) : new Map()
			}
		});
	}

	function onWindowKeydown(e: KeyboardEvent): void {
		if (pendingPromotion && e.key === 'Escape') {
			e.preventDefault();
			cancelPromotion();
		}
	}

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	onMount(() => {
		const chess = new Chess(fen);

		cg = Chessground(boardEl, {
			fen,
			orientation,
			turnColor: toColor(chess),
			movable: {
				// free: false means only allow squares listed in `dests` (i.e. legal moves).
				// If free were true, any piece could move anywhere — no rules enforced.
				free: false,
				color: interactive ? toColor(chess) : undefined,
				dests: interactive ? buildDests(chess) : new Map(),
				events: {
					after: handleAfterMove
				}
			},
			highlight: {
				lastMove: true, // yellow tint on origin and destination of last move
				check: true // red tint on the king when in check
			},
			animation: {
				enabled: true,
				duration: 200 // milliseconds for piece movement animation
			},
			lastMove: lastMove as [Key, Key] | undefined
		});

		// Signal the $effect below that the board is ready.
		initialized = true;

		// Cleanup: called by Svelte when this component is removed from the DOM.
		return () => {
			cg?.destroy();
		};
	});

	/**
	 * Keep the board in sync with props.
	 *
	 * This effect re-runs whenever `initialized`, `fen`, `orientation`,
	 * `interactive`, or `lastMove` change.  The `initialized` guard means it
	 * is a no-op until onMount has finished setting up the board.
	 *
	 * Why not put all of this in onMount?  Because onMount runs once.  We need
	 * the board to update whenever the parent passes a new FEN (e.g. after an
	 * opponent move is played in drill mode, or when the user navigates to a
	 * different position in build mode).
	 */
	$effect(() => {
		if (!initialized || !cg) return;

		// While the promotion chooser is open the board must stay frozen on the
		// pawn-on-last-rank view. untrack: opening the chooser must not re-run this.
		const pending = untrack(() => pendingPromotion);
		if (pending) {
			if (pending.baseFen === fen) return;
			pendingPromotion = null; // the position changed under the chooser
		}

		const chess = new Chess(fen);
		cg.set({
			fen,
			orientation,
			turnColor: toColor(chess),
			movable: {
				color: interactive ? toColor(chess) : undefined,
				dests: interactive ? buildDests(chess) : new Map()
			},
			lastMove: lastMove as [Key, Key] | undefined,
			drawable: {
				autoShapes
			}
		});
	});
</script>

<!--
	boardEl is bound to this div.  Chessground appends its own child elements
	(cg-container, cg-board, piece elements, square elements) inside here, and
	adds the `cg-wrap` CSS class automatically.

	The width is controlled by the parent — set a width on the parent element
	and the board will fill it.  Height is kept equal to width via aspect-ratio.
-->
<svelte:window onkeydown={onWindowKeydown} />

<div class="board-frame">
	<div bind:this={boardEl} class="board-wrap board-theme-{boardTheme}"></div>

	{#if pendingPromotion}
		{@const promo = pendingPromotion}
		<!--
			Promotion chooser. The cg-wrap class lets the pieces reuse Chessground's
			embedded piece images (they are all styled as `.cg-wrap piece.<role>.<color>`).
		-->
		<div class="promo-overlay cg-wrap" role="dialog" aria-label="Choose the promotion piece">
			<button
				type="button"
				class="promo-backdrop"
				aria-label="Cancel promotion"
				onclick={cancelPromotion}
			></button>
			{#each PROMOTION_CHOICES as choice, i (choice.piece)}
				<button
					type="button"
					class="promo-choice"
					style="left: {promo.col * 12.5}%; top: {(promo.row + promo.dir * i) * 12.5}%"
					aria-label="Promote to {choice.label.toLowerCase()}"
					title={choice.label}
					onclick={() => choosePromotion(choice.piece)}
				>
					<svelte:element this={'piece'} class="{choice.role} {promo.color}"></svelte:element>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	/*
		The board must always be a perfect square.
		aspect-ratio: 1/1 means height = width automatically.

		Chessground's base CSS positions its child elements absolutely inside
		the .cg-wrap wrapper (which Chessground adds to this div), so the
		wrapper must have explicit pixel dimensions — percentage heights alone
		would not work without this trick.
	*/
	.board-frame {
		position: relative;
		width: 100%;
	}

	.board-wrap {
		width: 100%;
		aspect-ratio: 1 / 1;
		/* Prevent browser from hijacking touch events for scroll/zoom —
		   Chessground handles its own touch events internally. */
		touch-action: none;
	}

	/* ── Promotion chooser ──────────────────────────────────────────────────── */

	/* .cg-wrap (needed for the piece images) sets position: relative; override it. */
	.promo-overlay {
		position: absolute;
		inset: 0;
		z-index: 20;
		box-sizing: border-box;
	}

	.promo-backdrop {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		background: rgba(0, 0, 0, 0.5);
		cursor: pointer;
	}

	.promo-choice {
		position: absolute;
		width: 12.5%;
		height: 12.5%;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.88);
		cursor: pointer;
	}

	.promo-choice:hover,
	.promo-choice:focus-visible {
		background: #fff;
		box-shadow: 0 0 12px 3px #f4a300;
		outline: none;
	}

	/* Chessground sizes and absolutely positions `piece` for its own board; here it
	   just fills its button. opacity !important beats the drill's blindfold rule
	   (.board-wrap.blindfold .cg-wrap piece { opacity: 0 !important }) by specificity,
	   because the user must still see the pieces to choose one. */
	.promo-overlay .promo-choice :global(piece) {
		position: static;
		display: block;
		width: 100%;
		height: 100%;
		opacity: 1 !important;
	}

	/* Shrink coordinate labels on small phones — --bp-sm */
	@media (max-width: 479px) {
		.board-wrap :global(coords) {
			font-size: 9px !important;
		}
	}
</style>
