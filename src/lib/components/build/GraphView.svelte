<script lang="ts">
	// GraphView — node-link visualization of the repertoire, replacing the
	// text-based MoveTree with a pannable/zoomable graph where transpositions
	// merge into a single shared node instead of being duplicated per branch.
	//
	// Layout: @dagrejs/dagre computes a layered (Sugiyama-style) layout.
	// rankdir 'BT' (bottom-to-top) puts the root at the bottom and grows
	// upward, matching the reference layout this was modeled on.
	//
	// Known limitation: a node's label shows the SAN of ONE representative
	// incoming edge (the first one found via BFS from the root). If two
	// different move orders converge on the same resulting position via
	// edges with genuinely different final SAN (e.g. 1.c4 c5 2.Nf3 vs.
	// 1.Nf3 c5 2.c4 — both end on the same position but the last move played
	// differs), only one of those SANs is shown on the shared node. This is
	// a real case, not just theoretical, and may need a follow-up
	// (e.g. multi-line labels or edge labels) if it proves confusing in
	// practice — noted here rather than silently glossed over.

	import dagre from '@dagrejs/dagre';
	import { buildMoveGraph, type GraphNode, type GraphEdge } from './moveGraphBuilder';
	import { untrack } from 'svelte';
	import type { RepertoireMove } from './buildState.svelte';
	import { fenKey } from '$lib/fen';

	interface Props {
		moves: RepertoireMove[];
		currentFen: string;
		startFen: string | null;
		repertoireColor: 'WHITE' | 'BLACK';
		onNavigateToLine: (sans: string[]) => void;
	}

	let { moves, currentFen, startFen, repertoireColor, onNavigateToLine }: Props = $props();

	const NODE_WIDTH = 64;
	const NODE_HEIGHT = 36;
	const NODE_SEP = 16;
	const RANK_SEP = 48;
	const MARGIN = 24;

	interface LaidOutNode extends GraphNode {
		x: number;
		y: number;
	}
	interface LaidOutEdge extends GraphEdge {
		points: { x: number; y: number }[];
	}

	const layout = $derived.by(() => {
		const graph = buildMoveGraph(moves, startFen);
		if (graph.nodes.length === 0) {
			return { nodes: [] as LaidOutNode[], edges: [] as LaidOutEdge[], width: 0, height: 0 };
		}

		const g = new dagre.graphlib.Graph();
		g.setGraph({
			rankdir: 'BT',
			nodesep: NODE_SEP,
			ranksep: RANK_SEP,
			marginx: MARGIN,
			marginy: MARGIN
		});
		g.setDefaultEdgeLabel(() => ({}));

		for (const n of graph.nodes) {
			g.setNode(n.fenKey, { width: NODE_WIDTH, height: NODE_HEIGHT });
		}
		for (const e of graph.edges) {
			// No 4th "name" argument: dagre only allows named/multi-edges in
			// multigraph mode, which we don't need — (fromKey, toKey) pairs
			// are already unique here, since two different moves from the
			// same position can never lead to the same resulting position.
			g.setEdge(e.fromKey, e.toKey);
		}

		dagre.layout(g);

		const nodes: LaidOutNode[] = graph.nodes.map((n) => {
			const pos = g.node(n.fenKey);
			return { ...n, x: pos.x, y: pos.y };
		});

		const edges: LaidOutEdge[] = graph.edges.map((e) => {
			const edgeLayout = g.edge(e.fromKey, e.toKey);
			return { ...e, points: edgeLayout?.points ?? [] };
		});

		const graphData = g.graph();
		return { nodes, edges, width: graphData.width ?? 0, height: graphData.height ?? 0 };
	});

	const currentFenKey = $derived(fenKey(currentFen));

	function pointsToPath(points: { x: number; y: number }[]): string {
		if (points.length === 0) return '';
		return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
	}

	function nodeLabel(node: LaidOutNode): string {
		return node.pathSans.length === 0 ? 'Start' : node.pathSans[node.pathSans.length - 1];
	}

	// A FEN's active-color field tells us who moves NEXT, so the color that
	// just played (the mover for this node) is the opposite of that field.
	// Comparing the mover against repertoireColor tells us whether this node
	// represents one of the user's own moves or an opponent reply — derived
	// per-node from its own FEN rather than from ply parity, so it stays
	// correct even with a custom startFen where the root isn't move 1.
	function isOwnMove(node: LaidOutNode): boolean {
		if (node.pathSans.length === 0) return false; // root — neither
		const activeColor = node.fen.split(' ')[1]; // 'w' or 'b', who moves next
		const moverColor = activeColor === 'w' ? 'b' : 'w';
		const ownColor = repertoireColor === 'WHITE' ? 'w' : 'b';
		return moverColor === ownColor;
	}

	function handleNodeClick(node: LaidOutNode) {
		onNavigateToLine(node.pathSans);
	}

	// ── Pan & zoom ──────────────────────────────────────────────────────────
	// Deliberately hand-rolled (CSS transform + pointer events) rather than a
	// third pan/zoom dependency, to avoid adding another package to audit for
	// what's a fairly small amount of logic.

	let viewport: HTMLDivElement | undefined = $state();
	let scale = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let isDragging = $state(false);
	let dragStartX = 0;
	let dragStartY = 0;
	let panStartX = 0;
	let panStartY = 0;
	let didDrag = false;

	// Re-centers on the current node whenever it changes, or whenever the
	// graph itself changes (a move was added/removed). Reads scale/viewport
	// through untrack so that zooming or panning — which change scale/panX/
	// panY but not currentFenKey — never re-trigger this and fight the
	// user's own zoom/pan.
	$effect(() => {
		const key = currentFenKey;
		const nodeList = layout.nodes;
		const node = nodeList.find((n) => n.fenKey === key);
		if (!node) return;

		untrack(() => {
			if (!viewport) return;
			const rect = viewport.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return;
			panX = rect.width / 2 - node.x * scale;
			panY = rect.height / 2 - node.y * scale;
		});
	});

	let activePointerId: number | null = null;

	function onPointerDown(e: PointerEvent) {
		isDragging = true;
		didDrag = false;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		panStartX = panX;
		panStartY = panY;
		activePointerId = e.pointerId;
		// No setPointerCapture here — capturing eagerly on every pointerdown
		// intercepts the button's own click, since a captured pointer's click
		// event resolves to the capturing element instead of the element
		// under the cursor. Capture is only taken once a real drag starts,
		// in onPointerMove below.
	}

	function onPointerMove(e: PointerEvent) {
		if (!isDragging) return;
		const dx = e.clientX - dragStartX;
		const dy = e.clientY - dragStartY;
		if (!didDrag && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
			didDrag = true;
			if (viewport && activePointerId !== null) {
				viewport.setPointerCapture(activePointerId);
			}
		}
		panX = panStartX + dx;
		panY = panStartY + dy;
	}

	function onPointerUp() {
		isDragging = false;
		activePointerId = null;
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const delta = e.deltaY > 0 ? -0.1 : 0.1;
		const newScale = Math.min(2.5, Math.max(0.3, scale + delta));
		if (!viewport) {
			scale = newScale;
			return;
		}
		// Zoom centered on the cursor rather than the canvas origin.
		const rect = viewport.getBoundingClientRect();
		const cx = e.clientX - rect.left;
		const cy = e.clientY - rect.top;
		const ratio = newScale / scale;
		panX = cx - (cx - panX) * ratio;
		panY = cy - (cy - panY) * ratio;
		scale = newScale;
	}

	function resetView() {
		scale = 1;
		panX = 0;
		panY = 0;
	}

	// A drag that moved the pointer more than a few pixels shouldn't also
	// fire a node click on release (native button click semantics would
	// otherwise fire click after any pointerup, including after a drag).
	function handleNodeClickGuarded(node: LaidOutNode) {
		if (didDrag) return;
		handleNodeClick(node);
	}
</script>

<div class="graph-view">
	<div class="graph-toolbar">
		<button class="graph-btn" onclick={resetView} title="Réinitialiser la vue">⟲</button>
	</div>
	{#if layout.nodes.length === 0}
		<div class="graph-empty">Aucun coup pour l'instant. Jouez un coup sur l'échiquier pour commencer.</div>
	{:else}
		<div
			class="graph-viewport"
			bind:this={viewport}
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			onwheel={onWheel}
			class:is-dragging={isDragging}
			role="application"
			aria-label="Graphe du répertoire"
		>
			<div
				class="graph-canvas"
				style="transform: translate({panX}px, {panY}px) scale({scale}); width: {layout.width}px; height: {layout.height}px;"
			>
				<svg class="graph-edges" width={layout.width} height={layout.height}>
					{#each layout.edges as edge (edge.id)}
						<path d={pointsToPath(edge.points)} class="graph-edge" />
					{/each}
				</svg>
				{#each layout.nodes as node (node.fenKey)}
					<button
						class="graph-node"
						class:is-current={node.fenKey === currentFenKey}
						class:is-root={node.pathSans.length === 0}
						class:is-own={isOwnMove(node)}
						class:is-opponent={node.pathSans.length > 0 && !isOwnMove(node)}
						style="left: {node.x - NODE_WIDTH / 2}px; top: {node.y - NODE_HEIGHT / 2}px; width: {NODE_WIDTH}px; height: {NODE_HEIGHT}px;"
						onclick={() => handleNodeClickGuarded(node)}
					>
						{nodeLabel(node)}
					</button>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.graph-view {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.graph-toolbar {
		position: absolute;
		top: var(--space-2);
		right: var(--space-2);
		z-index: 2;
	}

	.graph-btn {
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
		border-radius: 4px;
		width: 28px;
		height: 28px;
		font-size: 14px;
		cursor: pointer;
		transition:
			color var(--dur-fast) var(--ease-snap),
			border-color var(--dur-fast) var(--ease-snap);
	}

	.graph-btn:hover {
		color: var(--color-accent);
		border-color: var(--color-accent);
	}

	.graph-empty {
		color: var(--color-text-muted);
		font-size: 12px;
		font-style: italic;
		padding: var(--space-4);
	}

	.graph-viewport {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		cursor: grab;
		background: var(--color-surface-alt);
		border-radius: 6px;
		touch-action: none;
	}

	.graph-viewport.is-dragging {
		cursor: grabbing;
	}

	.graph-canvas {
		position: relative;
		transform-origin: 0 0;
	}

	.graph-edges {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
		overflow: visible;
	}

	.graph-edge {
		fill: none;
		stroke: var(--color-border);
		stroke-width: 1.5px;
	}

	.graph-node {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		border-radius: 6px;
		font-size: 12px;
		font-weight: 600;
		font-family: var(--font-body);
		cursor: pointer;
		transition:
			transform var(--dur-fast) var(--ease-snap),
			box-shadow var(--dur-fast) var(--ease-snap);
	}

	.graph-node.is-own {
		background: var(--color-accent);
		color: #fff;
	}

	.graph-node.is-opponent {
		background: var(--color-surface-alt);
		color: var(--color-text-muted);
		border: 1px solid var(--color-border);
		font-weight: 500;
	}

	.graph-node:hover {
		transform: scale(1.06);
	}

	.graph-node.is-current {
		box-shadow: 0 0 0 2px #fff;
	}

	.graph-node.is-root {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
	}
</style>
