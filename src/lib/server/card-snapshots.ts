// Daily snapshots of the card counts shown in /stats (total and struggling).
//
// Neither count can be rebuilt from other tables, so they are written as the
// app is used: /stats refreshes today's row on each load, and the top-menu
// badge endpoint (/api/nav-counts, called after every grade and on navigation,
// focus and a slow timer) refreshes it in the background. The last write of a
// local day wins. A repertoire with no in-scope card is not recorded.

import { db } from '$lib/db';
import { cardSnapshot, userMove, userRepertoireMove, repertoire } from '$lib/db/schema';
import { and, eq, asc } from 'drizzle-orm';
import { scopeCards } from '$lib/server/due-counts';
import { isStrugglingCard, type CardSnapshotPoint } from '$lib/stats-aggregation';
import { makeDayFormatter } from '$lib/local-days';

type RepertoireRow = typeof repertoire.$inferSelect;

export interface SnapshotCounts {
	total: number;
	struggling: number;
}

/** Counts for the cards already scope-filtered by scopeCards. */
export function countCards(
	cards: { state: number | null; lapses: number | null; scheduledDays: number | null }[]
): SnapshotCounts {
	let struggling = 0;
	for (const c of cards) if (isStrugglingCard(c)) struggling++;
	return { total: cards.length, struggling };
}

/** Writes (or overwrites) the snapshot of `day`. No-op for an empty repertoire. */
export async function upsertCardSnapshot(
	userId: number,
	repertoireId: number,
	day: string,
	counts: SnapshotCounts
): Promise<void> {
	if (counts.total === 0) return;
	const now = new Date();
	await db
		.insert(cardSnapshot)
		.values({
			userId,
			repertoireId,
			day,
			totalCards: counts.total,
			strugglingCards: counts.struggling,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: [cardSnapshot.userId, cardSnapshot.repertoireId, cardSnapshot.day],
			set: { totalCards: counts.total, strugglingCards: counts.struggling, updatedAt: now }
		});
}

/** All snapshots of one repertoire, oldest first. */
export async function loadCardSnapshots(
	userId: number,
	repertoireId: number
): Promise<CardSnapshotPoint[]> {
	const rows = await db
		.select({
			day: cardSnapshot.day,
			total: cardSnapshot.totalCards,
			struggling: cardSnapshot.strugglingCards
		})
		.from(cardSnapshot)
		.where(and(eq(cardSnapshot.userId, userId), eq(cardSnapshot.repertoireId, repertoireId)))
		.orderBy(asc(cardSnapshot.day));
	return rows;
}

async function recordFromDatabase(
	userId: number,
	rep: RepertoireRow,
	timeZone: string
): Promise<void> {
	const [moves, cards] = await Promise.all([
		db
			.select()
			.from(userMove)
			.where(and(eq(userMove.userId, userId), eq(userMove.repertoireId, rep.id))),
		db
			.select()
			.from(userRepertoireMove)
			.where(
				and(eq(userRepertoireMove.userId, userId), eq(userRepertoireMove.repertoireId, rep.id))
			)
	]);
	const day = makeDayFormatter(timeZone)(new Date());
	await upsertCardSnapshot(userId, rep.id, day, countCards(scopeCards(rep, moves, cards)));
}

// Runs for the same user and repertoire never overlap: a call that arrives
// while one is running only asks for one more run afterwards, so the last
// grade of a session is always reflected without stacking up queries.
const running = new Map<string, boolean>();

/** Fire-and-forget refresh of today's snapshot. Never throws. */
export function scheduleCardSnapshot(userId: number, rep: RepertoireRow, timeZone: string): void {
	const key = `${userId}:${rep.id}`;
	if (running.has(key)) {
		running.set(key, true);
		return;
	}
	void (async () => {
		try {
			do {
				running.set(key, false);
				await recordFromDatabase(userId, rep, timeZone);
			} while (running.get(key));
		} catch (err) {
			console.error('card snapshot refresh failed', err);
		} finally {
			running.delete(key);
		}
	})();
}
