<script lang="ts">
	// ── Endgame drill page ───────────────────────────────────────────────────
	//
	// Same overall shape as /puzzles (fetchNext → handleMove → auto-grade →
	// fetchNext), adapted for the endgame module's specifics:
	//   - No stored solution line. Each move is validated live against the
	//     Lichess tablebase (see api/endgame/validate-move).
	//   - The app auto-plays the defending side (api/endgame/opponent-move),
	//     since a position has two sides and no stored line plays them.
	//   - The FSRS rating (Forgot/Unsure/Easy) is computed automatically from
	//     objective play data, never chosen by the user (api/endgame/grade).
	//   - Mode ('practice' | 'theory') comes from the server, derived from the
	//     position's category — 'theory' forces the exact optimal move at
	//     every step (mandatory replay on a suboptimal-but-sound move);
	//     'practice' only requires the WDL result class to be preserved.
	//
	// Phase machine:
	//   loading → playing → validating → (rejected → playing) | (accepted →
	//   opponent-thinking → playing) → complete → loading (next card)
	//   Terminal states: no-cards, error.

	import ChessBoard from '$lib/components/ChessBoard.svelte';
	import ResizableBoard from '$lib/components/ResizableBoard.svelte';
	import { onMount } from 'svelte';
	import { Chess } from 'chess.js';
	import {
		initSounds,
		setSoundEnabled,
		playMove,
		playCapture,
		playCorrect,
		playIncorrect
	} from '$lib/sounds';
	import { toFullFen } from '$lib/fen';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Phase =
		| 'loading'
		| 'playing'
		| 'validating'
		| 'opponent-thinking'
		| 'complete'
		| 'no-cards'
		| 'error';

	interface EndgamePosition {
		fen: string;
		category: string;
		subcategory: string;
		target: 'checkmate' | 'draw';
		mateInHint: number | null;
		pieceCount: number;
	}

	interface EndgameCard {
		id: number;
		fen: string;
	}

	// ── State ────────────────────────────────────────────────────────────────

	let phase = $state<Phase>('loading');
	let card = $state<EndgameCard | null>(null);
	let position = $state<EndgamePosition | null>(null);
	let mode = $state<'practice' | 'theory'>('practice');
	let currentFen = $state('');
	let orientation = $state<'white' | 'black'>('white');
	let lastMove = $state<[string, string] | undefined>(undefined);
	let errorMessage = $state('');
	let feedback = $state('');
	let boardKey = $state(0); // bump to force ChessBoard to re-sync to currentFen
	let soundEnabled = $state(true);
	let flashColor = $state<'green' | 'red' | null>(null);

	// Objective tracking for the card currently in play — reset on every
	// fetchNextCard(). Drives computeRating() at completion.
	let initialDtz = $state<number | null>(null);
	let totalPlies = $state(0);
	let hadUnsoundMove = $state(false);
	let currentMoveAttempts = $state(0);
	let maxAttemptsOnAnyMove = $state(0);
	let drawPliesWithoutDegradation = $state(0);
	const DRAW_PLY_THRESHOLD = 30;
	const THEORY_MAX_RETRIES = 2; // 2 genuine retries, then reveal on the 3rd failure

	const timers = new Set<ReturnType<typeof setTimeout>>();
	function safeTimeout(fn: () => void, ms: number) {
		const id = setTimeout(() => {
			timers.delete(id);
			fn();
		}, ms);
		timers.add(id);
		return id;
	}

	function resetAttemptState() {
		initialDtz = null;
		totalPlies = 0;
		hadUnsoundMove = false;
		currentMoveAttempts = 0;
		maxAttemptsOnAnyMove = 0;
		drawPliesWithoutDegradation = 0;
	}

	// ── Loading the next card ───────────────────────────────────────────────

	async function fetchNextCard() {
		phase = 'loading';
		feedback = '';
		try {
			const res = await fetch('/api/endgame/next');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const next = await res.json();
			if (!next) {
				phase = 'no-cards';
				return;
			}
			card = next.card;
			position = next.position;
			mode = next.mode;
			currentFen = toFullFen(position!.fen);
			orientation = currentFen.split(' ')[1] === 'w' ? 'white' : 'black';
			lastMove = undefined;
			resetAttemptState();
			boardKey++;
			phase = 'playing';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
			phase = 'error';
		}
	}

	// ── Handling a move ─────────────────────────────────────────────────────

	async function handleMove(
		from: string,
		to: string,
		san: string,
		_newFen: string,
		isCapture: boolean
	) {
		if (phase !== 'playing' || !position) return;

		const beforeFen = currentFen;
		const chess = new Chess(beforeFen);
		let moveObj;
		try {
			moveObj = chess.move(san);
		} catch {
			return; // ChessBoard already validated legality — shouldn't happen
		}
		const uci = moveObj.from + moveObj.to + (moveObj.promotion ?? '');
		const afterFen = chess.fen();

		phase = 'validating';

		let evaluation;
		try {
			const res = await fetch('/api/endgame/validate-move', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ fen: beforeFen, uci })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			evaluation = await res.json();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
			phase = 'error';
			return;
		}

		if (!evaluation.found) {
			errorMessage = 'Synchronisation perdue avec la tablebase. Rechargez la page.';
			phase = 'error';
			return;
		}

		if (initialDtz === null) {
			initialDtz = Math.abs(evaluation.positionDtz ?? 0);
		}

		if (!evaluation.sound) {
			// Rejected, not fatal to the session: the move is undone so the
			// user can keep demonstrating the position, but it's remembered
			// for grading (see computeRating) — a real result-changing error
			// still counts as Forgot even though play continues.
			hadUnsoundMove = true;
			playIncorrect();
			feedback = 'Ce coup abandonne le résultat de la position. Coup annulé, réessayez.';
			flashColor = 'red';
			safeTimeout(() => (flashColor = null), 600);
			boardKey++;
			phase = 'playing';
			return;
		}

		if (mode === 'theory' && !evaluation.optimal) {
			currentMoveAttempts++;

			if (currentMoveAttempts > THEORY_MAX_RETRIES && evaluation.bestMove) {
				// Stop asking the user to retry indefinitely — reveal the
				// correct move and continue. maxAttemptsOnAnyMove already
				// guarantees a Forgot rating at completion (see
				// computeRating), this only fixes the stuck UX, not scoring.
				playIncorrect();
				feedback = `Le coup était ${evaluation.bestMove.san}. On continue.`;
				flashColor = 'red';
				safeTimeout(() => (flashColor = null), 600);

				const revealChess = new Chess(beforeFen);
				const revealMove = revealChess.move({
					from: evaluation.bestMove.uci.slice(0, 2),
					to: evaluation.bestMove.uci.slice(2, 4),
					promotion: evaluation.bestMove.uci.slice(4) || undefined
				});
				await acceptMove(
					revealChess,
					evaluation.bestMove.uci.slice(0, 2),
					evaluation.bestMove.uci.slice(2, 4),
					Boolean(revealMove.captured)
				);
				return;
			}

			playIncorrect();
			feedback = `Coup correct, mais pas le plus rapide vers le mat. Rejouez (essai ${currentMoveAttempts + 1}).`;
			flashColor = 'red';
			safeTimeout(() => (flashColor = null), 600);
			boardKey++;
			phase = 'playing';
			return;
		}

		feedback = '';
		await acceptMove(chess, from, to, isCapture);
	}

	// Shared tail of handleMove: commit an accepted move (user-played or
	// revealed) and continue the session. Does not touch `feedback` — the
	// caller sets it (or clears it) before calling, since the reveal path
	// needs its message to survive past this call.
	async function acceptMove(chess: Chess, from: string, to: string, isCapture: boolean) {
		maxAttemptsOnAnyMove = Math.max(maxAttemptsOnAnyMove, currentMoveAttempts);
		currentMoveAttempts = 0;
		totalPlies++;
		currentFen = chess.fen();
		lastMove = [from, to];
		if (isCapture) playCapture();
		else playMove();

		if (chess.isGameOver()) {
			await completeCard();
			return;
		}
		if (position?.target === 'draw') {
			drawPliesWithoutDegradation++;
			if (drawPliesWithoutDegradation >= DRAW_PLY_THRESHOLD) {
				await completeCard();
				return;
			}
		}

		await playOpponentMove();
	}

	// ── Opponent auto-play ──────────────────────────────────────────────────

	async function playOpponentMove() {
		phase = 'opponent-thinking';
		try {
			const res = await fetch('/api/endgame/opponent-move', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ fen: currentFen })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const { move } = await res.json();

			if (!move) {
				// No legal moves left for the opponent.
				await completeCard();
				return;
			}

			const chess = new Chess(currentFen);
			chess.move({
				from: move.uci.slice(0, 2),
				to: move.uci.slice(2, 4),
				promotion: move.uci.slice(4) || undefined
			});
			currentFen = chess.fen();
			lastMove = [move.uci.slice(0, 2), move.uci.slice(2, 4)];
			totalPlies++;
			boardKey++;
			playMove();

			if (chess.isGameOver()) {
				await completeCard();
				return;
			}
			phase = 'playing';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
			phase = 'error';
		}
	}

	// ── Automatic grading ───────────────────────────────────────────────────

	function computeRating(): 1 | 3 | 4 {
		if (hadUnsoundMove) return 1; // Forgot
		if (mode === 'theory') {
			if (maxAttemptsOnAnyMove > 2) return 1;
			if (maxAttemptsOnAnyMove === 0) return 4;
			return 3;
		}
		const extra = initialDtz !== null ? totalPlies - initialDtz : 0;
		return extra <= 0 ? 4 : 3;
	}

	async function completeCard() {
		if (!card) return;
		const rating = computeRating();
		flashColor = rating === 1 ? 'red' : 'green';
		if (rating === 1) playIncorrect();
		else playCorrect();
		safeTimeout(() => (flashColor = null), 600);
		phase = 'complete';

		try {
			await fetch('/api/endgame/grade', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cardId: card.id, rating, mode })
			});
		} catch {
			// Unlike puzzles' attempt recording, a failed grade here silently
			// leaves this card's SR schedule stale — worth saying so, not
			// staying quiet the way a non-critical failure normally would.
			feedback = "La note n'a pas pu être enregistrée (problème réseau). L'exercice suivant se charge quand même.";
		}

		safeTimeout(fetchNextCard, 1200);
	}

	// ── Board size persistence (shared app-wide setting) ────────────────────

	function handleBoardResize(size: number) {
		fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ boardSize: size })
		});
	}

	onMount(() => {
		initSounds();
		soundEnabled = data.settings?.soundEnabled ?? true;
		setSoundEnabled(soundEnabled);
		fetchNextCard();
		return () => {
			for (const id of timers) clearTimeout(id);
			timers.clear();
		};
	});
</script>

<div class="page">
	<div class="board-col">
		<ResizableBoard boardSize={data.settings?.boardSize ?? 0} onResize={handleBoardResize}>
			<div class="board-wrap">
				{#if currentFen}
					{#key boardKey}
						<ChessBoard
							fen={currentFen}
							{orientation}
							boardTheme={data.settings?.boardTheme ?? 'blue'}
							interactive={phase === 'playing'}
							{lastMove}
							onMove={handleMove}
						/>
					{/key}
				{/if}
				{#if flashColor}
					<div
						class="flash-overlay"
						class:flash-correct={flashColor === 'green'}
						class:flash-incorrect={flashColor === 'red'}
					></div>
				{/if}
				{#if phase === 'opponent-thinking'}
					<div class="status-badge">L'adversaire réfléchit&hellip;</div>
				{:else if phase === 'validating'}
					<div class="status-badge">Validation&hellip;</div>
				{/if}
			</div>
		</ResizableBoard>
	</div>

	<div class="sidebar">
		{#if phase === 'loading'}
			<p>Chargement&hellip;</p>
		{:else if phase === 'no-cards'}
			<div class="empty-state">
				<h2>Rien à réviser pour l'instant</h2>
				<p>Toutes les positions ont déjà été vues et aucune n'est due aujourd'hui.</p>
			</div>
		{:else if phase === 'error'}
			<div class="empty-state">
				<h2>Erreur</h2>
				<p>{errorMessage}</p>
				<button onclick={fetchNextCard}>Réessayer</button>
			</div>
		{:else if position}
			<div class="position-info">
				<span class="badge mode-badge" class:theory={mode === 'theory'}>
					{mode === 'theory' ? 'Théorie' : 'Pratique'}
				</span>
				<h2>{position.category} — {position.subcategory}</h2>
				<p class="target">
					{position.target === 'checkmate' ? 'Objectif : mater' : 'Objectif : tenir la nulle'}
				</p>
			</div>
			{#if feedback}
				<p class="feedback">{feedback}</p>
			{/if}
			{#if phase === 'complete'}
				<p class="complete-msg">Carte notée, chargement de la suivante&hellip;</p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-3);
	}

	.board-col {
		width: 100%;
	}

	@media (min-width: 768px) {
		.page {
			display: grid;
			grid-template-columns: auto 280px;
			gap: var(--space-4);
			align-items: start;
			justify-content: center;
			padding: 0;
		}
	}

	@media (min-width: 1024px) {
		.page {
			grid-template-columns: auto 340px;
			gap: var(--space-6);
			max-width: 1100px;
			margin: 0 auto;
		}
	}

	.board-wrap {
		position: relative;
		width: 100%;
	}

	.sidebar {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		font-family: var(--font-body);
	}

	.flash-overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
		border-radius: var(--radius-sm);
		animation: flash-fade 0.6s ease-out forwards;
	}

	.flash-correct {
		background: rgba(74, 222, 128, 0.35);
	}

	.flash-incorrect {
		background: rgba(248, 113, 113, 0.35);
	}

	@keyframes flash-fade {
		from {
			opacity: 1;
		}
		to {
			opacity: 0;
		}
	}

	.status-badge {
		position: absolute;
		bottom: var(--space-2);
		left: 50%;
		transform: translateX(-50%);
		background: rgba(0, 0, 0, 0.7);
		color: var(--color-text-secondary);
		font-size: 0.75rem;
		font-family: var(--font-body);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-sm);
	}

	.position-info {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-4);
	}

	.position-info h2 {
		margin: var(--space-2) 0;
		color: var(--color-text-primary);
	}

	.target {
		color: var(--color-text-secondary);
		margin: 0;
	}

	.badge {
		display: inline-block;
		font-size: 0.75rem;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--color-surface-alt);
		color: var(--color-text-secondary);
	}

	.mode-badge.theory {
		background: var(--color-accent);
		color: var(--color-base);
	}

	.feedback {
		background: var(--color-surface-alt);
		border-radius: var(--radius-sm);
		padding: var(--space-3);
		color: var(--color-text-primary);
	}

	.complete-msg {
		color: var(--color-success);
	}

	.empty-state {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-6);
		text-align: center;
	}
</style>
