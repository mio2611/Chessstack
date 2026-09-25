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
	import type { DrawShape } from '@lichess-org/chessground/draw';
	import type { Key } from '@lichess-org/chessground/types';
	import { onMount } from 'svelte';
	import { Chess } from 'chess.js';
	import { initSounds, setSoundEnabled, playCorrect, playIncorrect } from '$lib/sounds';
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

	// Green arrow for the correct move, shown once the answer is revealed
	// after a wrong move — same mechanism build mode uses for its own
	// candidate-move arrows.
	const arrowShapes = $derived<DrawShape[]>(
		phase === 'incorrect' && expected
			? [{ orig: expected.from as Key, dest: expected.to as Key, brush: 'green' }]
			: []
	);

	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive, used only for cleanup
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

	function handleMove(from: string, to: string, san: string): void {
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
			feedback =
				'The grade could not be saved (network problem). The next exercise is loading anyway.';
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
							autoShapes={arrowShapes}
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
			<p class="setup-desc">Loading&hellip;</p>
		{:else if phase === 'no-cards'}
			<div class="empty-state">
				<h2>Nothing to review right now</h2>
				<p class="setup-desc">No blunder positions are due today.</p>
			</div>
		{:else if phase === 'error'}
			<div class="empty-state">
				<h2>Error</h2>
				<p class="setup-desc">{errorMessage}</p>
				<button class="btn btn--secondary" onclick={fetchNextCard}>Retry</button>
			</div>
		{:else if card}
			<div class="sidebar-header">
				<h2>What is the best move?</h2>
			</div>

			{#if feedback}
				<p class="feedback">{feedback}</p>
			{/if}

			{#if phase === 'playing'}
				<p class="setup-desc">Play the move on the board.</p>
			{:else if phase === 'correct'}
				<div class="feedback feedback--correct">
					<span class="feedback-icon">✓</span> Correct
				</div>
				<div class="section">
					<div class="section-label">HOW CONFIDENT WAS YOUR RESPONSE?</div>
					<div class="grade-buttons">
						<button
							class="grade-btn grade-btn--forgot"
							onclick={() => submitGrade(1)}
							disabled={grading}
						>
							<span class="grade-label">Forgot</span>
							<span class="grade-interval">{card.intervalLabels.forgot}</span>
						</button>
						<button
							class="grade-btn grade-btn--unsure"
							onclick={() => submitGrade(3)}
							disabled={grading}
						>
							<span class="grade-label">Unsure</span>
							<span class="grade-interval">{card.intervalLabels.unsure}</span>
						</button>
						<button
							class="grade-btn grade-btn--easy"
							onclick={() => submitGrade(4)}
							disabled={grading}
						>
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
						<div class="section-label">CORRECT MOVE</div>
						<div class="revealed-move">{revealedSan}</div>
					</div>
				{/if}
				<p class="auto-advance-hint">Will be graded as Forgot</p>
				<button class="btn btn--primary next-btn" onclick={handleIncorrectNext} disabled={grading}>
					Next <kbd>Space</kbd>
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
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: var(--space-4);
		box-shadow: var(--shadow-surface);
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

	.sidebar-header h2 {
		margin: 0;
		font-size: 1rem;
		color: var(--color-text-primary);
	}

	.setup-desc {
		font-size: 0.78rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin: 0;
	}

	.feedback {
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-3);
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.5;
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
		font-size: 11px;
		font-family: var(--font-body);
		font-weight: 700;
		letter-spacing: 0.12em;
		color: var(--color-text-muted);
		text-transform: uppercase;
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
		padding: var(--space-3) var(--space-2);
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		font-size: 0.8rem;
		font-family: var(--font-body);
		font-weight: 700;
		cursor: pointer;
		transition: filter var(--dur-fast) var(--ease-snap);
	}

	.grade-label {
		font-size: 0.8rem;
	}

	.grade-interval {
		font-size: 0.65rem;
		font-weight: 500;
		opacity: 0.75;
	}

	.grade-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.grade-btn:not(:disabled):hover {
		filter: brightness(1.15);
	}

	.grade-btn--forgot {
		background: rgba(248, 113, 113, 0.18);
		border-color: rgba(248, 113, 113, 0.45);
		color: var(--color-danger);
	}

	.grade-btn--unsure {
		background: rgba(91, 127, 164, 0.15);
		border-color: rgba(91, 127, 164, 0.4);
		color: var(--color-accent);
	}

	.grade-btn--easy {
		background: rgba(74, 222, 128, 0.18);
		border-color: rgba(74, 222, 128, 0.45);
		color: var(--color-success);
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
		margin: 0;
	}

	.btn {
		display: block;
		text-align: center;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-md);
		font-size: 0.85rem;
		font-family: var(--font-body);
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		transition: filter var(--dur-fast) var(--ease-snap);
	}

	.btn:hover:not(:disabled) {
		filter: brightness(1.15);
	}

	.btn--primary {
		background: var(--color-accent);
		border-color: var(--color-accent);
		color: var(--color-base);
	}

	.btn--secondary {
		background: var(--color-surface);
		border-color: var(--color-border);
		color: var(--color-text-secondary);
	}

	kbd {
		display: inline-block;
		padding: 0.05rem 0.3rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface);
		color: var(--color-text-muted);
		font-size: 0.65rem;
		font-family: var(--font-body);
		line-height: 1.4;
	}

	/* No box of its own: the sidebar card already frames it */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.empty-state h2 {
		margin: 0;
		font-size: 1rem;
		color: var(--color-text-primary);
	}
</style>
