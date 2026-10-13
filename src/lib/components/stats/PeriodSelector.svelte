<script lang="ts">
	import type { Period } from '$lib/stats-aggregation';

	let {
		value = $bindable(),
		name
	}: {
		value: Period;
		name: string; // radio group name, unique per chart on the page
	} = $props();

	const options: { key: Period; label: string }[] = [
		{ key: '1m', label: '1 month' },
		{ key: '1y', label: '1 year' },
		{ key: 'all', label: 'Deck life' }
	];
</script>

<div class="period-selector" role="radiogroup" aria-label="Period">
	{#each options as opt (opt.key)}
		<label class="period-option" class:selected={value === opt.key}>
			<input type="radio" {name} value={opt.key} bind:group={value} />
			{opt.label}
		</label>
	{/each}
</div>

<style>
	.period-selector {
		display: flex;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}

	.period-option {
		font-size: 12px;
		color: var(--color-text-secondary);
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		cursor: pointer;
	}

	.period-option.selected {
		color: var(--color-text-primary);
		border-color: var(--color-accent);
		background: var(--color-accent-glow);
	}

	.period-option:focus-within {
		outline: 2px solid var(--color-accent);
		outline-offset: 1px;
	}

	input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
</style>
