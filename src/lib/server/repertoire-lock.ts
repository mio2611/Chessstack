// Serialises the writers of one repertoire's move tree.
//
// Every endpoint that adds, replaces or deletes moves does "look at what is
// stored, then write". Two requests running at the same time (two tabs, two
// devices, a double click that slips past the button guard) both look before
// either writes, and both write: two moves from one position, two drill cards
// for one move. user_move and user_repertoire_move have no unique constraint
// that could refuse the second write, and "one move per position for the user"
// cannot be expressed as one anyway (whose turn it is depends on the
// repertoire's colour).
//
// So each such endpoint opens a transaction and takes this lock first. It is a
// row lock on the repertoire: the second transaction waits until the first one
// commits, then looks, and sees the first one's work. One repertoire is locked
// at a time, so there is no lock-ordering deadlock.

import { db } from '$lib/db';
import { repertoire } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

// Transaction type extracted from db.transaction() callback parameter
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lock the repertoire row until the transaction ends. Must be the first thing
 * the transaction does, before reading anything it relies on.
 *
 * Returns false when the repertoire no longer exists (deleted meanwhile).
 */
export async function lockRepertoire(tx: Transaction, repertoireId: number): Promise<boolean> {
	const rows = await tx
		.select({ id: repertoire.id })
		.from(repertoire)
		.where(eq(repertoire.id, repertoireId))
		.for('update');
	return rows.length > 0;
}
