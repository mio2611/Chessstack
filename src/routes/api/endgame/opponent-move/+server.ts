// POST /api/endgame/opponent-move — picks the defending side's move at a
// given position (their turn), used to auto-play the non-user side during
// an endgame drill. See $lib/tablebase.ts pickBestDefense for the selection
// logic and its stated limitations.

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pickBestDefense, TablebaseApiError } from '$lib/tablebase';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	const { fen } = body;
	if (typeof fen !== 'string') throw error(400, 'fen must be a string');

	try {
		const move = await pickBestDefense(fen);
		return json({ move });
	} catch (err) {
		if (err instanceof TablebaseApiError) {
			throw error(502, `Tablebase unavailable: ${err.message}`);
		}
		throw err;
	}
};
