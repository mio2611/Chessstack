<script lang="ts">
	// ── Anti-gaffe drill page ────────────────────────────────────────────────
	//
	// Same overall shape as /endgame (standalone position, fetchNext →
	// handleMove → fetchNext, no line tree to walk), but graded like /drill:
	// there's no tablebase to validate against, so the rating is
	// self-reported (Forgot/Unsure/Easy) rather than computed from objective
	// play data.
	//
	// The move actually played is compared against the card's
	// confirmedMoveSan structurally (from/to/promotion, derived once via
	// chess.js when the card loads) rather than as a raw SAN string — avoids
	// false negatives from check/mate suffix formatting differences.
	//
	// Phase machine:
	//   loading → playing → (correct → grading) | (incorrect) → loading (next)
	//   Terminal states: no-cards, error.

	import ChessBoard from '$lib/components/ChessBoard.svelte';
	import ResizableBoard from '$lib/components/ResizableBoard.svelte';
	import { onMount } from 'svelte';
	import { Chess } from 'chess.js';
	import { initSounds, setSoundEnabled, playMove, playCorrect, playIncorrect } from '$lib/sounds';
	import { toFullFen } from '$lib/fen';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Phase = 'loading' | 'playing' | 'correct' | 'incorrect' | 'no-cards' | 'error';

	interface AntiGaffeCard {
		id: number;
		fen: string;
		confirmedMoveSan: string;
		intervalLabels: { forgot: string; unsure: string; easy: string };
	}

	let phase = $state<Phase>('loading');
	let card = $state<AntiGaffeCard | null>(null);
	let currentFen = $state('');
	let orientation = $state<'white' | 'black'>('white');
	let lastMove = $state<[string, string] | undefined>(undefined);
	let errorMessage = $state('');
	let feedback = $state('');
	let boardKey = $state(0); // bump to force ChessBoard to re-sync to currentFen
	let soundEnabled = $state(true);
	let flashColor = $state<'green' | 'red' | null>(null);
	let grading = $state(false);
	let revealedSan = $state<string | null>(null);

	// Expected move for the card in play, derived once when it loads —
	// compared structurally, not as a SAN string. Null if confirmedMoveSan
	// turns out to be unparseable against fen (shouldn't happen, but a
	// stale/edited card is possible).
	let expected = $state<{ from: string; to: string; promotion: string | undefined } | null>(null);

	const timers = new Set<ReturnType<typeof setTimeout>>();
	function safeTimeout(fn: () => void, ms: number) {
		const id = setTimeout(() => {
			timers.delete(id);
			fn();
		}, ms);
		timers.add(id);
		return id;
	}

	// ── Loading the next card ───────────────────────────────────────────────

	async function fetchNextCard() {
		phase = 'loading';
		feedback = '';
		revealedSan = null;
		try {
			const res = await fetch('/api/anti-gaffe/next');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const next = await res.json();
			if (!next) {
				phase = 'no-cards';
				return;
			}
			card = next;
			currentFen = toFullFen(card!.fen);
			orientation = currentFen.split(' ')[1] === 'w' ? 'white' : 'black';
			lastMove = undefined;

			try {
				const chess = new Chess(currentFen);
				const move = chess.move(card!.confirmedMoveSan);
				expected = { from: move.from, to: move.to, promotion: move.promotion };
			} catch {
				expected = null;
			}

			boardKey++;
			phase = 'playing';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
			phase = 'error';
		}
	}

	// ── Handling a move ─────────────────────────────────────────────────────

	function handleMove(from: string, to: string, san: string, _newFen: string): void {
		if (phase !== 'playing' || !card) return;

		const chess = new Chess(currentFen);
		let moveObj;
		try {
			moveObj = chess.move(san);
		} catch {
			return; // ChessBoard already validated legality — shouldn't happen
		}

		const isCorrect =
			expected !== null &&
			from === expected.from &&
			to === expected.to &&
			(moveObj.promotion ?? undefined) === expected.promotion;

		if (isCorrect) {
			playCorrect();
			flashColor = 'green';
			safeTimeout(() => (flashColor = null), 600);
			currentFen = chess.fen();
			lastMove = [from, to];
			boardKey++;
			phase = 'correct';
		} else {
			playIncorrect();
			flashColor = 'red';
			safeTimeout(() => (flashColor = null), 600);
			revealedSan = card.confirmedMoveSan;
			boardKey++; // snap the board back — the wrong move is not committed
			phase = 'incorrect';
		}
	}

	// ── Grading ──────────────────────────────────────────────────────────────

	async function submitGrade(rating: 1 | 3 | 4) {
		if (!card || grading) return;
		grading = true;
		try {
			await fetch('/api/anti-gaffe/grade', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cardId: card.id, rating })
			});
		} catch {
			// Unlike a failed move, a failed grade here silently leaves this
			// card's SR schedule stale — worth saying so, not staying quiet.
			feedback = "La note n'a pas pu être enregistrée (problème réseau). L'exercice suivant se charge quand même.";
		}
		grading = false;
		await fetchNextCard();
	}

	// Wrong move: always graded Forgot, no choice offered — matches /drill's
	// own convention for the incorrect path.
	async function handleIncorrectNext() {
		await submitGrade(1);
	}

	// ── Board size persistence (shared app-wide setting) ────────────────────

	function handleBoardResize(size: number) {
		fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ boardSize: size })
		});
	}

	function handleKey(e: KeyboardEvent) {
		if (phase === 'correct') {
			if (e.key === '1') submitGrade(1);
			else if (e.key === '2') submitGrade(3);
			else if (e.key === '3') submitGrade(4);
		} else if (phase === 'incorrect' && e.key === ' ') {
			e.preventDefault();
			handleIncorrectNext();
		}
	}

	onMount(() => {
		initSounds();
		soundEnabled = data.settings?.soundEnabled ?? true;
		setSoundEnabled(soundEnabled);
		fetchNextCard();
		window.addEventListener('keydown', handleKey);
		return () => {
			window.removeEventListener('keydown', handleKey);
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
			</div>
		</ResizableBoard>
	</div>

	<div class="sidebar">
		{#if phase === 'loading'}
			<p>Chargement&hellip;</p>
		{:else if phase === 'no-cards'}
			<div class="empty-state">
				<h2>Rien à réviser pour l'instant</h2>
				<p>Toutes les positions anti-gaffe ont déjà été vues et aucune n'est due aujourd'hui.</p>
			</div>
		{:else if phase === 'error'}
			<div class="empty-state">
				<h2>Erreur</h2>
				<p>{errorMessage}</p>
				<button onclick={fetchNextCard}>Réessayer</button>
			</div>
		{:else if card}
			<div class="position-info">
				<h2>Quel est le meilleur coup ?</h2>
			</div>

			{#if feedback}
				<p class="feedback">{feedback}</p>
			{/if}

			{#if phase === 'playing'}
				<p class="hint">Jouez le coup sur l'échiquier.</p>
			{:else if phase === 'correct'}
				<div class="feedback feedback--correct">
					<span class="feedback-icon">✓</span> Correct
				</div>
				<div class="section">
					<div class="section-label">QUELLE ÉTAIT VOTRE CONFIANCE ?</div>
					<div class="grade-buttons">
						<button class="grade-btn grade-btn--forgot" onclick={() => submitGrade(1)} disabled={grading}>
							<span class="grade-label">Forgot</span>
							<span class="grade-interval">{card.intervalLabels.forgot}</span>
						</button>
						<button class="grade-btn grade-btn--unsure" onclick={() => submitGrade(3)} disabled={grading}>
							<span class="grade-label">Unsure</span>
							<span class="grade-interval">{card.intervalLabels.unsure}</span>
						</button>
						<button class="grade-btn grade-btn--easy" onclick={() => submitGrade(4)} disabled={grading}>
							<span class="grade-label">Easy</span>
							<span class="grade-interval">{card.intervalLabels.easy}</span>
						</button>
					</div>
					<div class="shortcut-hints">
						<span class="shortcut"><kbd>1</kbd> Forgot</span>
						<span class="shortcut"><kbd>2</kbd> Unsure</span>
						<span class="shortcut"><kbd>3</kbd> Easy</span>
					</div>
				</div>
			{:else if phase === 'incorrect'}
				<div class="feedback feedback--incorrect">
					<span class="feedback-icon">✗</span> Incorrect
				</div>
				{#if revealedSan}
					<div class="section">
						<div class="section-label">COUP CORRECT</div>
						<div class="revealed-move">{revealedSan}</div>
					</div>
				{/if}
				<p class="auto-advance-hint">Sera noté Forgot</p>
				<button class="btn btn--primary next-btn" onclick={handleIncorrectNext} disabled={grading}>
					Suivant <kbd>Espace</kbd>
				</button>
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

	.position-info {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-4);
	}

	.position-info h2 {
		margin: 0;
		color: var(--color-text-primary);
	}

	.hint {
		color: var(--color-text-secondary);
	}

	.feedback {
		background: var(--color-surface-alt);
		border-radius: var(--radius-sm);
		padding: var(--space-3);
		color: var(--color-text-primary);
	}

	.feedback--correct {
		color: var(--color-success);
	}

	.feedback--incorrect {
		color: var(--color-danger);
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.section-label {
		font-size: 0.7rem;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
	}

	.grade-buttons {
		display: flex;
		gap: var(--space-2);
	}

	.grade-btn {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: var(--space-2);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface);
		cursor: pointer;
	}

	.grade-label {
		font-size: 0.8rem;
		color: var(--color-text-primary);
	}

	.grade-interval {
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.shortcut-hints {
		display: flex;
		gap: var(--space-3);
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.revealed-move {
		font-size: 1.1rem;
		font-weight: 700;
		color: var(--color-text-primary);
	}

	.auto-advance-hint {
		color: var(--color-text-muted);
		font-size: 0.8rem;
	}

	.empty-state {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-6);
		text-align: center;
	}
</style>
