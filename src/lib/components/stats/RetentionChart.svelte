<script lang="ts">
	import PeriodSelector from './PeriodSelector.svelte';
	import {
		buildChartData,
		niceCeil,
		rate,
		type ChartBucket,
		type DailyStat,
		type Period
	} from '$lib/stats-aggregation';

	let {
		daily,
		today,
		targetRetention
	}: { daily: DailyStat[]; today: string; targetRetention: number } = $props();

	let period = $state<Period>('1m');

	const chart = $derived(buildChartData(daily, period, today));

	// Plot area inside a 640 x 260 viewBox.
	const W = 640;
	const H = 260;
	const ML = 44;
	const MR = 44;
	const MT = 12;
	const MB = 30;
	const plotW = W - ML - MR;
	const plotH = H - MT - MB;

	const buckets = $derived(chart?.buckets ?? []);
	const step = $derived(buckets.length > 0 ? plotW / buckets.length : plotW);
	const barW = $derived(Math.max(1, step * 0.7));

	const maxReviews = $derived(Math.max(1, ...buckets.map((b) => b.youngReviews + b.matureReviews)));
	// At least 2 so the mid gridline label is a whole number.
	const countMax = $derived(Math.max(2, niceCeil(maxReviews)));

	// Right axis (retention): from just under the lowest observed rate up to 100%.
	const rateMin = $derived.by(() => {
		let lowest = 1;
		for (const b of buckets) {
			for (const r of [
				rate(b.youngSuccess, b.youngReviews),
				rate(b.matureSuccess, b.matureReviews)
			]) {
				if (r !== null && r < lowest) lowest = r;
			}
		}
		return Math.min(0.9, Math.max(0, Math.floor((lowest - 0.05) * 10) / 10));
	});

	const xCenter = (i: number) => ML + step * i + step / 2;
	const yCount = (v: number) => MT + plotH - (v / countMax) * plotH;
	const yRate = (r: number) => MT + plotH - ((r - rateMin) / (1 - rateMin)) * plotH;

	// Buckets without any review have no rate: the line skips them and joins the
	// neighbouring points (as Anki does), the tooltip still shows each bucket's count.
	function ratePoints(pick: (b: ChartBucket) => number | null): { x: number; y: number }[] {
		const pts: { x: number; y: number }[] = [];
		buckets.forEach((b, i) => {
			const r = pick(b);
			if (r !== null) pts.push({ x: xCenter(i), y: yRate(r) });
		});
		return pts;
	}

	function pathOf(pts: { x: number; y: number }[]): string {
		return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
	}

	const youngPoints = $derived(ratePoints((b) => rate(b.youngSuccess, b.youngReviews)));
	const maturePoints = $derived(ratePoints((b) => rate(b.matureSuccess, b.matureReviews)));
	const youngPath = $derived(pathOf(youngPoints));
	const maturePath = $derived(pathOf(maturePoints));
	// A single point has no segment to draw: show it as a dot.
	const youngDots = $derived(youngPoints.length === 1 ? youngPoints : []);
	const matureDots = $derived(maturePoints.length === 1 ? maturePoints : []);

	const showTarget = $derived(targetRetention >= rateMin && targetRetention <= 1);

	// About six x labels, evenly spread.
	const labelEvery = $derived(Math.max(1, Math.ceil(buckets.length / 6)));

	function dateLabel(day: string): string {
		return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		});
	}

	function pct(r: number | null): string {
		return r === null ? 'n/a' : `${Math.round(r * 100)}%`;
	}

	function tooltip(b: ChartBucket): string {
		const when =
			chart?.granularity === 'week' ? `Week of ${dateLabel(b.start)}` : dateLabel(b.start);
		return (
			`${when}\n` +
			`Young: ${b.youngReviews} review${b.youngReviews === 1 ? '' : 's'}, ` +
			`${pct(rate(b.youngSuccess, b.youngReviews))}\n` +
			`Mature: ${b.matureReviews} review${b.matureReviews === 1 ? '' : 's'}, ` +
			`${pct(rate(b.matureSuccess, b.matureReviews))}`
		);
	}
</script>

<div class="widget-label">Retention</div>
{#if !chart}
	<p class="widget-empty">
		No scheduled reviews logged yet. This starts accumulating from your first drill session after
		this feature was deployed.
	</p>
{:else}
	<svg
		viewBox="0 0 {W} {H}"
		class="chart"
		role="img"
		aria-label="Reviews per period and retention rate"
	>
		<!-- Gridlines and left axis (review count) -->
		{#each [0, 0.5, 1] as f (f)}
			<line x1={ML} x2={W - MR} y1={yCount(countMax * f)} y2={yCount(countMax * f)} class="grid" />
			<text x={ML - 6} y={yCount(countMax * f) + 4} class="axis axis-left">
				{Math.round(countMax * f)}
			</text>
			<text x={W - MR + 6} y={yRate(rateMin + (1 - rateMin) * f) + 4} class="axis axis-right">
				{Math.round((rateMin + (1 - rateMin) * f) * 100)}%
			</text>
		{/each}

		{#if showTarget}
			<line
				x1={ML}
				x2={W - MR}
				y1={yRate(targetRetention)}
				y2={yRate(targetRetention)}
				class="target"
			/>
		{/if}

		<!-- Review counts: mature at the bottom, young stacked on top -->
		{#each buckets as b, i (b.start)}
			<rect
				x={xCenter(i) - barW / 2}
				y={yCount(b.matureReviews)}
				width={barW}
				height={yCount(0) - yCount(b.matureReviews)}
				class="bar-mature"
			/>
			<rect
				x={xCenter(i) - barW / 2}
				y={yCount(b.matureReviews + b.youngReviews)}
				width={barW}
				height={yCount(b.matureReviews) - yCount(b.matureReviews + b.youngReviews)}
				class="bar-young"
			/>
		{/each}

		<!-- Retention rates -->
		<path d={youngPath} class="line line-young" />
		<path d={maturePath} class="line line-mature" />
		{#each youngDots as p (`y${p.x}`)}
			<circle cx={p.x} cy={p.y} r="2.5" class="dot-young" />
		{/each}
		{#each matureDots as p (`m${p.x}`)}
			<circle cx={p.x} cy={p.y} r="2.5" class="dot-mature" />
		{/each}

		<!-- X labels -->
		{#each buckets as b, i (b.start)}
			{#if i % labelEvery === 0}
				<text x={xCenter(i)} y={H - 10} class="axis axis-x">{dateLabel(b.start)}</text>
			{/if}
		{/each}

		<!-- Hover targets, one per bucket, carrying the tooltip -->
		{#each buckets as b, i (b.start)}
			<rect x={ML + step * i} y={MT} width={step} height={plotH} class="hit">
				<title>{tooltip(b)}</title>
			</rect>
		{/each}
	</svg>

	<div class="chart-legend">
		<span class="legend-item"
			><span class="legend-dot" style="background: var(--color-accent-dim)"></span> Young reviews</span
		>
		<span class="legend-item"
			><span class="legend-dot" style="background: var(--color-success)"></span> Mature reviews</span
		>
		<span class="legend-item"
			><span class="legend-dot" style="background: var(--color-eval-inaccuracy)"></span> Young retention</span
		>
		<span class="legend-item"
			><span class="legend-dot" style="background: var(--color-eval-mistake)"></span> Mature retention</span
		>
		{#if showTarget}
			<span class="legend-item"
				><span class="legend-dash"></span> Target {Math.round(targetRetention * 100)}%</span
			>
		{/if}
	</div>
	<p class="widget-note">
		Scheduled drill reviews of cards in the Review state only. Young = interval under 21 days. Bars
		count reviews (left axis), lines show the share not graded Again (right axis).
		{#if chart.granularity === 'week'}
			Each point is one week (Monday to Sunday).
		{/if}
		A point built from few reviews is noisy: hover it to see how many it holds.
	</p>
{/if}

<PeriodSelector bind:value={period} name="retention-period" />

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

	.target {
		stroke: var(--color-text-muted);
		stroke-width: 1;
		stroke-dasharray: 4 4;
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

	.bar-young {
		fill: var(--color-accent-dim);
		opacity: 0.75;
	}

	.bar-mature {
		fill: var(--color-success);
		opacity: 0.75;
	}

	.line {
		fill: none;
		stroke-width: 2;
		stroke-linejoin: round;
	}

	.line-young {
		stroke: var(--color-eval-inaccuracy);
	}

	.line-mature {
		stroke: var(--color-eval-mistake);
	}

	.dot-young {
		fill: var(--color-eval-inaccuracy);
	}

	.dot-mature {
		fill: var(--color-eval-mistake);
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

	.legend-dash {
		display: inline-block;
		width: 14px;
		border-top: 1px dashed var(--color-text-muted);
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
