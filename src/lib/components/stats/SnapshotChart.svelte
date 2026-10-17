<script lang="ts">
	import PeriodSelector from './PeriodSelector.svelte';
	import {
		buildSnapshotSeries,
		type CardSnapshotPoint,
		type Period,
		type SnapshotBucket
	} from '$lib/stats-aggregation';

	let {
		points,
		today,
		field,
		title,
		note,
		color,
		name
	}: {
		points: CardSnapshotPoint[];
		today: string;
		field: 'total' | 'struggling';
		title: string;
		note: string;
		color: string; // CSS color for the line
		name: string; // radio group name, unique per chart on the page
	} = $props();

	let period = $state<Period>('1m');

	const series = $derived(buildSnapshotSeries(points, period, today));
	const buckets = $derived<SnapshotBucket[]>(series?.buckets ?? []);
	const values = $derived(buckets.map((b) => b[field]));

	const current = $derived(values.length > 0 ? values[values.length - 1] : 0);
	const change = $derived(values.length > 0 ? current - values[0] : 0);

	// Plot area inside a 640 x 220 viewBox.
	const W = 640;
	const H = 220;
	const ML = 44;
	const MR = 12;
	const MT = 12;
	const MB = 30;
	const plotW = W - ML - MR;
	const plotH = H - MT - MB;

	// The axis hugs the data (a count that moves by a few units would be a flat
	// line on a zero-based axis) with a margin so the line never touches an edge.
	const axis = $derived.by(() => {
		if (values.length === 0) return { lo: 0, hi: 1 };
		const min = Math.min(...values);
		const max = Math.max(...values);
		const pad = Math.max(1, Math.ceil((max - min) * 0.15));
		return { lo: Math.max(0, min - pad), hi: max + pad };
	});

	const step = $derived(buckets.length > 0 ? plotW / buckets.length : plotW);
	const xCenter = (i: number) => ML + step * i + step / 2;
	const y = (v: number) => MT + plotH - ((v - axis.lo) / (axis.hi - axis.lo)) * plotH;

	const linePath = $derived(
		values
			.map((v, i) => `${i === 0 ? 'M' : 'L'}${xCenter(i).toFixed(1)},${y(v).toFixed(1)}`)
			.join(' ')
	);

	const ticks = $derived(
		[axis.hi, (axis.hi + axis.lo) / 2, axis.lo].map((v) => ({ y: y(v), label: Math.round(v) }))
	);

	const labelEvery = $derived(Math.max(1, Math.ceil(buckets.length / 6)));

	function dateLabel(day: string): string {
		return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		});
	}

	function signed(n: number): string {
		return n > 0 ? `+${n}` : `${n}`;
	}

	function tooltip(i: number): string {
		const when =
			series?.granularity === 'week'
				? `Week of ${dateLabel(buckets[i].start)}`
				: dateLabel(buckets[i].start);
		return `${when}\n${values[i]} cards`;
	}
</script>

<div class="widget-label">{title}</div>
{#if !series}
	<p class="widget-empty">
		No snapshot yet. One is stored each day you use the app, starting from this deployment: nothing
		before that can be reconstructed.
	</p>
{:else}
	<svg viewBox="0 0 {W} {H}" class="chart" role="img" aria-label={title}>
		{#each ticks as t, i (i)}
			<line x1={ML} x2={W - MR} y1={t.y} y2={t.y} class="grid" />
			<text x={ML - 6} y={t.y + 4} class="axis axis-left">{t.label}</text>
		{/each}

		<path d={linePath} class="line" style="stroke: {color}" />
		{#if buckets.length <= 40}
			{#each values as v, i (buckets[i].start)}
				<circle cx={xCenter(i)} cy={y(v)} r="2.5" style="fill: {color}" />
			{/each}
		{/if}

		{#each buckets as b, i (b.start)}
			{#if i % labelEvery === 0}
				<text x={xCenter(i)} y={H - 10} class="axis axis-x">{dateLabel(b.start)}</text>
			{/if}
		{/each}

		{#each buckets as b, i (b.start)}
			<rect x={ML + step * i} y={MT} width={step} height={plotH} class="hit">
				<title>{tooltip(i)}</title>
			</rect>
		{/each}
	</svg>

	<dl class="summary">
		<dt>Now</dt>
		<dd>{current} cards</dd>
		<dt>Change over the period</dt>
		<dd>{signed(change)} cards</dd>
	</dl>
	<p class="widget-note">
		{note}
		{#if series.granularity === 'week'}
			Each point is the value at the end of a week (Monday to Sunday).
		{/if}
	</p>
{/if}

<PeriodSelector bind:value={period} {name} />

<style>
	.chart {
		width: 100%;
		height: auto;
		display: block;
	}

	.grid {
		stroke: var(--color-border);
		stroke-width: 1;
	}

	.axis {
		font-size: 10px;
		fill: var(--color-text-muted);
	}

	.axis-left {
		text-anchor: end;
	}

	.axis-x {
		text-anchor: middle;
	}

	.line {
		fill: none;
		stroke-width: 2;
		stroke-linejoin: round;
	}

	.hit {
		fill: transparent;
	}

	.hit:hover {
		fill: var(--color-accent-glow);
	}

	.summary {
		display: grid;
		grid-template-columns: auto auto;
		justify-content: start;
		gap: var(--space-1) var(--space-4);
		margin: var(--space-3) 0 0;
		font-size: 13px;
	}

	.summary dt {
		color: var(--color-text-secondary);
	}

	.summary dd {
		margin: 0;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.widget-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-muted);
		margin-bottom: var(--space-3);
	}

	.widget-empty,
	.widget-note {
		color: var(--color-text-muted);
		font-size: 13px;
		margin: var(--space-2) 0 0;
	}
</style>
