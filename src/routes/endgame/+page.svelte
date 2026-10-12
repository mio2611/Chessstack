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
	// Category filter (right sidebar): the user unticks the subcategories that
	// must not supply NEW positions (e.g. KQ vs K, KRR vs K, already mastered).
	// The unticked list is kept in this browser's localStorage, not in the
	// database, and sent to /api/endgame/next on every request. Due reviews are
	// not filtered unless "Apply to due reviews too" is ticked.
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
	import { refreshNavCounts } from '$lib/stores/navCounts';
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

	// ── Category filter state ────────────────────────────────────────────────

	interface StatRow {
		category: string;
		subcategory: string;
		total: number;
		done: number;
		due: number;
	}

	interface SubGroup extends StatRow {
		newCount: number;
		excluded: boolean;
	}

	interface CategoryGroup {
		category: string;
		total: number;
		done: number;
		due: number;
		newCount: number;
		selection: 'all' | 'some' | 'none';
		subs: SubGroup[];
	}

	const FILTER_STORAGE_KEY = 'chessstack.endgame.filter.v1';

	let stats = $state<StatRow[]>([]);
	// Excluded subcategories, each encoded as JSON.stringify([category, subcategory]).
	let excluded = $state<string[]>([]);
	let limitReviews = $state(false);
	let expanded = $state<string[]>([]);

	function pairKey(category: string, subcategory: string): string {
		return JSON.stringify([category, subcategory]);
	}

	let groups = $derived.by<CategoryGroup[]>(() => {
		const out: CategoryGroup[] = [];
		for (const row of stats) {
			let g = out.find((x) => x.category === row.category);
			if (!g) {
				g = {
					category: row.category,
					total: 0,
					done: 0,
					due: 0,
					newCount: 0,
					selection: 'all',
					subs: []
				};
				out.push(g);
			}
			g.total += row.total;
			g.done += row.done;
			g.due += row.due;
			g.newCount += row.total - row.done;
			g.subs.push({
				...row,
				newCount: row.total - row.done,
				excluded: excluded.includes(pairKey(row.category, row.subcategory))
			});
		}
		for (const g of out) {
			const nbExcluded = g.subs.filter((x) => x.excluded).length;
			g.selection = nbExcluded === 0 ? 'all' : nbExcluded === g.subs.length ? 'none' : 'some';
		}
		return out;
	});

	function loadSavedFilter() {
		try {
			const raw = localStorage.getItem(FILTER_STORAGE_KEY);
			if (!raw) return;
			const saved = JSON.parse(raw);
			if (Array.isArray(saved.excluded)) {
				excluded = saved.excluded.filter((k: unknown): k is string => typeof k === 'string');
			}
			limitReviews = saved.limitReviews === true;
		} catch {
			// Unreadable or unavailable storage: start with everything selected.
		}
	}

	function saveFilter() {
		try {
			localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ excluded, limitReviews }));
		} catch {
			// Storage unavailable (private mode, quota): the filter just won't persist.
		}
	}

	async function loadStats() {
		try {
			const res = await fetch('/api/endgame/stats');
			if (!res.ok) return;
			const body = await res.json();
			stats = body.rows;
		} catch {
			// The panel is informational; the drill itself does not depend on it.
		}
	}

	function onFilterChanged() {
		saveFilter();
		// A change applies from the next card. When the session is stuck on
		// "nothing to review", re-query right away so the new selection is tried.
		if (phase === 'no-cards') fetchNextCard();
	}

	function toggleSub(category: string, subcategory: string) {
		const k = pairKey(category, subcategory);
		excluded = excluded.includes(k) ? excluded.filter((x) => x !== k) : [...excluded, k];
		onFilterChanged();
	}

	function toggleCategory(g: CategoryGroup) {
		const keys = g.subs.map((x) => pairKey(x.category, x.subcategory));
		if (g.selection === 'all') {
			excluded = [...excluded, ...keys.filter((k) => !excluded.includes(k))];
		} else {
			excluded = excluded.filter((k) => !keys.includes(k));
		}
		onFilterChanged();
	}

	function selectAll() {
		excluded = [];
		onFilterChanged();
	}

	function toggleExpanded(category: string) {
		expanded = expanded.includes(category)
			? expanded.filter((c) => c !== category)
			: [...expanded, category];
	}

	function nextUrl(): string {
		const parts: string[] = [];
		if (excluded.length > 0) {
			const pairs = excluded.map((k) => JSON.parse(k));
			parts.push(`exclude=${encodeURIComponent(JSON.stringify(pairs))}`);
		}
		if (limitReviews) parts.push('reviews=selection');
		return parts.length > 0 ? `/api/endgame/next?${parts.join('&')}` : '/api/endgame/next';
	}

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
			const res = await fetch(nextUrl());
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
			errorMessage = 'Lost sync with the tablebase. Reload the page.';
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
			feedback = 'That move throws away the result of the position. Move undone, try again.';
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
				feedback = `The move was ${evaluation.bestMove.san}. Moving on.`;
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
			feedback = `Correct move, but not the fastest way to mate. Try again (attempt ${currentMoveAttempts + 1}).`;
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
			void refreshNavCounts();
			void loadStats();
		} catch {
			// Unlike puzzles' attempt recording, a failed grade here silently
			// leaves this card's SR schedule stale — worth saying so, not
			// staying quiet the way a non-critical failure normally would.
			feedback =
				'The grade could not be saved (network problem). The next exercise is loading anyway.';
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
		loadSavedFilter();
		void loadStats();
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
					<div class="status-badge">Opponent thinking&hellip;</div>
				{:else if phase === 'validating'}
					<div class="status-badge">Validating&hellip;</div>
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
				<p class="setup-desc">
					No endgame positions are due, and no new positions are left in the current selection.
				</p>
			</div>
		{:else if phase === 'error'}
			<div class="empty-state">
				<h2>Error</h2>
				<p class="setup-desc">{errorMessage}</p>
				<button class="retry-btn" onclick={fetchNextCard}>Retry</button>
			</div>
		{:else if position}
			<div class="sidebar-header">
				<span class="badge mode-badge" class:theory={mode === 'theory'}>
					{mode === 'theory' ? 'Theory' : 'Practice'}
				</span>
				<h2>{position.category} &mdash; {position.subcategory}</h2>
			</div>
			<div class="goal-display">
				<span class="goal-label">Goal</span>
				<span class="goal-value">
					{position.target === 'checkmate' ? 'Checkmate' : 'Hold the draw'}
				</span>
			</div>
			{#if feedback}
				<p class="feedback">{feedback}</p>
			{/if}
			{#if phase === 'complete'}
				<p class="complete-msg">Card graded, loading the next one&hellip;</p>
			{/if}
		{/if}

		{#if groups.length > 0}
			<div class="filter-panel">
				<div class="filter-header">
					<span class="filter-label">Focus</span>
					<button class="filter-link" onclick={selectAll} disabled={excluded.length === 0}>
						Select all
					</button>
				</div>
				<p class="filter-hint">Untick what should not supply new positions.</p>
				<div class="filter-cols" aria-hidden="true">
					<span class="filter-cols-spacer"></span>
					<span title="Positions in the database">Total</span>
					<span title="Graded at least once">Done</span>
					<span title="Due now">Due</span>
					<span title="Never graded">New</span>
					<span class="filter-cols-expand"></span>
				</div>
				{#each groups as g (g.category)}
					<div class="cat-row" class:cat-off={g.selection === 'none'}>
						<label class="cat-name">
							<input
								type="checkbox"
								checked={g.selection === 'all'}
								indeterminate={g.selection === 'some'}
								onchange={() => toggleCategory(g)}
							/>
							<span>{g.category}</span>
						</label>
						<span class="num">{g.total}</span>
						<span class="num">{g.done}</span>
						<span class="num" class:num-due={g.due > 0}>{g.due}</span>
						<span class="num">{g.newCount}</span>
						<button
							class="expand-btn"
							onclick={() => toggleExpanded(g.category)}
							aria-expanded={expanded.includes(g.category)}
							aria-label="Show subcategories of {g.category}"
						>
							{expanded.includes(g.category) ? '▾' : '▸'}
						</button>
					</div>
					{#if expanded.includes(g.category)}
						{#each g.subs as sub (sub.subcategory)}
							<div class="sub-row" class:cat-off={sub.excluded}>
								<label class="cat-name">
									<input
										type="checkbox"
										checked={!sub.excluded}
										onchange={() => toggleSub(sub.category, sub.subcategory)}
									/>
									<span>{sub.subcategory}</span>
								</label>
								<span class="num">{sub.total}</span>
								<span class="num">{sub.done}</span>
								<span class="num" class:num-due={sub.due > 0}>{sub.due}</span>
								<span class="num">{sub.newCount}</span>
								<span class="expand-btn"></span>
							</div>
						{/each}
					{/if}
				{/each}
				<label class="reviews-toggle">
					<input type="checkbox" bind:checked={limitReviews} onchange={onFilterChanged} />
					<span>Apply to due reviews too</span>
				</label>
			</div>
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

	.filter-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
	}

	.filter-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.filter-label {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-weight: 700;
	}

	.filter-link {
		background: none;
		border: none;
		padding: 0;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		text-decoration: underline;
		cursor: pointer;
	}

	.filter-link:disabled {
		opacity: 0.4;
		cursor: default;
		text-decoration: none;
	}

	.filter-hint {
		margin: 0 0 var(--space-1);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.filter-cols,
	.cat-row,
	.sub-row {
		display: grid;
		grid-template-columns: 1fr repeat(4, 2.4rem) 1.5rem;
		align-items: center;
		column-gap: var(--space-1);
	}

	.filter-cols {
		font-size: 0.65rem;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		text-align: right;
	}

	.cat-row {
		font-size: 0.85rem;
		color: var(--color-text-primary);
		padding: 2px 0;
	}

	.sub-row {
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		padding: 1px 0 1px var(--space-4);
	}

	.cat-off {
		opacity: 0.45;
	}

	.cat-name {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
		cursor: pointer;
	}

	.cat-name span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.num-due {
		font-weight: 700;
		color: var(--color-text-primary);
	}

	.expand-btn {
		background: none;
		border: none;
		padding: 0;
		color: var(--color-text-secondary);
		cursor: pointer;
		text-align: center;
	}

	.reviews-toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-2);
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.sidebar-header {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.sidebar-header h2 {
		margin: 0;
		font-size: 1rem;
		color: var(--color-text-primary);
	}

	/* Same inner box as the Trainer Rating row on /train */
	.goal-display {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		background: rgba(91, 127, 164, 0.08);
		border: 1px solid rgba(91, 127, 164, 0.2);
	}

	.goal-label {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-weight: 700;
	}

	.goal-value {
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--color-accent);
	}

	.setup-desc {
		font-size: 0.78rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
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
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: var(--space-3);
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.5;
		color: var(--color-text-primary);
	}

	.retry-btn {
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-text-primary);
		font-size: 0.85rem;
		font-weight: 600;
		font-family: var(--font-body);
		cursor: pointer;
		min-height: 44px;
	}

	.retry-btn:hover {
		border-color: var(--color-accent);
	}

	.complete-msg {
		color: var(--color-success);
		font-size: 0.85rem;
		margin: 0;
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
