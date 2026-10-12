// Due counts shown as badges in the top menu (Drill, Endgames, Blunders).
//
// The layout keeps the active repertoire id here and refreshes on mount,
// repertoire change, navigation, tab focus and a slow timer (cards become due
// as time passes). Study pages call refreshNavCounts() after a grade so the
// badge follows the session instead of waiting for the next navigation.

import { writable } from 'svelte/store';
import { base } from '$app/paths';

export interface NavCounts {
	drill: number;
	endgame: number;
	antiGaffe: number;
}

export const navCounts = writable<NavCounts>({ drill: 0, endgame: 0, antiGaffe: 0 });

let repertoireId: number | null = null;
let latestRequest = 0;

export function setNavRepertoire(id: number | null): void {
	repertoireId = id;
}

export async function refreshNavCounts(): Promise<void> {
	// Only the most recent request may write: an older, slower response must
	// not overwrite a newer count.
	const ticket = ++latestRequest;
	try {
		const qs = repertoireId === null ? '' : `?repertoireId=${repertoireId}`;
		const res = await fetch(`${base}/api/nav-counts${qs}`);
		if (!res.ok || ticket !== latestRequest) return;
		navCounts.set((await res.json()) as NavCounts);
	} catch {
		// Badges are best-effort: keep the previous values on a network error.
	}
}
