<script lang="ts">
	import PeriodSelector from './PeriodSelector.svelte';
	import {
		alignZero,
		buildChartData,
		netSeries,
		type DailyStat,
		type Period
	} from '$lib/stats-aggregation';

	let { daily, today }: { daily: DailyStat[]; today: string } = $props();

	let period = $state<Period>('1m');

	const chart = $derived(buildChartData(daily, period, today));
	const buckets = $derived(chart?.buckets ?? []);
	const series = $derived(netSeries(buckets));

	const total = $derived(series.cumulative.length > 0 ? series.cumulative.at(-1)! : 0);
	const perDay = $derived(chart ? total / chart.rangeDays : 0);

	// Plot area inside a 640 x 240 viewBox.
	const W = 640;
	const H = 240;
	const ML = 44;
	const MR = 44;
	const MT = 12;
	const MB = 30;
	const plotW = W - ML - MR;
	const plotH = H - MT - MB;

	const step = $derived(buckets.length > 0 ? plotW / buckets.length : plotW);
	const barW = $derived(Math.max(1, step * 0.7));

	// Bars (net per bucket) and line (running total) get separate scales, widened
	// so that both put zero on the same horizontal line.
	const axes = $derived.by(() => {
		const range = (values: number[]): [number, number] => [
			Math.min(0, ...values),
			Math.max(0, ...values)
		];
		return alignZero(range(series.net), range(series.cumulative));
	});

	const yBar = (v: number) => MT + plotH - ((v - axes.a[0]) / (axes.a[1] - axes.a[0])) * plotH;
	const yLine = (v: number) => MT + plotH - ((v - axes.b[0]) / (axes.b[1] - axes.b[0])) * plotH;
	const xCenter = (i: number) => ML + step * i + step / 2;

	const linePath = $derived(
		series.cumulative
			.map((v, i) => `${i === 0 ? 'M' : 'L'}${xCenter(i).toFixed(1)},${yLine(v).toFixed(1)}`)
			.join(' ')
	);

	// Top, zero and (when anything is negative) bottom labels for each axis.
	const ticks = $derived.by(() => {
		const pairs: [number, number][] = [
			[axes.a[1], axes.b[1]],
			[0, 0]
		];
		if (axes.a[0] < 0) pairs.push([axes.a[0], axes.b[0]]);
		return pairs.map(([left, right]) => ({
			y: yBar(left),
			left: Math.round(left),
			right: Math.round(right),
			isZero: left === 0
		}));
	});

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
		const b = buckets[i];
		const when =
			chart?.granularity === 'week' ? `Week of ${dateLabel(b.start)}` : dateLabel(b.start);
		return (
			`${when}\n` +
			`Net ${signed(series.net[i])} (${b.matured} matured, ${b.lost} lost)\n` +
			`Cumulative ${signed(series.cumulative[i])}`
		);
	}
</script>

<div class="widget-label">Net Matured Cards</div>
{#if !chart}
	<p class="widget-empty">
		No reviews logged yet. This starts accumulating from your first drill session after this feature
		was deployed.
	</p>
{:else}
	<svg viewBox="0 0 {W} {H}" class="chart" role="img" aria-label="Net change in mature cards">
		{#each ticks as t, i (i)}
			<line x1={ML} x2={W - MR} y1={t.y} y2={t.y} class={t.isZero ? 'zero' : 'grid'} />
			<text x={ML - 6} y={t.y + 4} class="axis axis-left">{t.left}</text>
			<text x={W - MR + 6} y={t.y + 4} class="axis axis-right">{t.right}</text>
		{/each}

		{#each buckets as b, i (b.start)}
			{@const n = series.net[i]}
			<rect
				x={xCenter(i) - barW / 2}
				y={n >= 0 ? yBar(n) : yBar(0)}
				width={barW}
				height={Math.abs(yBar(n) - yBar(0))}
				class={n >= 0 ? 'bar-gain' : 'bar-loss'}
			/>
		{/each}

		<path d={linePath} class="line" />

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

	<div class="chart-legend">
		<span class="legend-item"
			><span class="legend-dot" style="background: var(--color-success)"></span> Net gain</span
		>
		<span class="legend-item"
			><span class="legend-dot" style="background: var(--color-danger)"></span> Net loss</span
		>
		<span class="legend-item"
			><span class="legend-dot" style="background: var(--color-text-primary)"></span> Cumulative</span
		>
	</div>

	<dl class="summary">
		<dt>Average</dt>
		<dd>{perDay.toFixed(1)} cards/day</dd>
		<dt>Total</dt>
		<dd>{signed(total)} cards</dd>
	</dl>
	<p class="widget-note">
		Cards that became mature (interval of 21 days or more) minus mature cards that were lost,
		counted from the review log. The total can differ from the Mature count in Deck Composition: the
		log only starts when it was deployed, and it forgets cards you deleted.
		{#if chart.granularity === 'week'}
			Each bar is one week (Monday to Sunday).
		{/if}
	</p>
{/if}

<PeriodSelector bind:value={period} name="matured-period" />

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

	.zero {
		stroke: var(--color-border-strong);
		stroke-width: 1;
	}

	.axis {
		font-size: 10px;
		fill: var(--color-text-muted);
	}

	.axis-left {
		text-anchor: end;
	}

	.axis-right {
		text-anchor: start;
	}

	.axis-x {
		text-anchor: middle;
	}

	.bar-gain {
		fill: var(--color-success);
		opacity: 0.8;
	}

	.bar-loss {
		fill: var(--color-danger);
		opacity: 0.8;
	}

	.line {
		fill: none;
		stroke: var(--color-text-primary);
		stroke-width: 2;
		stroke-linejoin: round;
	}

	.hit {
		fill: transparent;
	}

	.hit:hover {
		fill: var(--color-accent-glow);
	}

	.chart-legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin-top: var(--space-2);
		font-size: 12px;
		color: var(--color-text-secondary);
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.legend-dot {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		flex-shrink: 0;
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
