// Authentication helpers — session creation, validation, and deletion.
//
// A session is a row in the `session` table that links a random token (UUID)
// to a user ID. The token is stored as a cookie in the browser.
//
// All functions here are async because the PostgreSQL driver is async.

import crypto from 'crypto';
import { db } from '$lib/db';
import { session } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

// The cookie name. Must match exactly between the code that sets the cookie
// (login action) and the code that reads it (hooks.server.ts).
export const SESSION_COOKIE_NAME = 'chessstack_session';

// Derive cookie "secure" flag from the ORIGIN env var.
// If ORIGIN starts with https://, the app is accessed over HTTPS and cookies
// must be marked secure. Otherwise (plain HTTP), secure must be false or the
// browser will silently reject the cookie.
export const SECURE_COOKIE = (process.env.ORIGIN ?? '').startsWith('https://');

// Sessions are valid for 30 days. The expiry slides: whenever a request arrives
// with less than half of that time left, the session is extended by a full
// 30 days (see validateSession). A session therefore only expires after 30
// days without use, not 30 days after login.
const SESSION_DURATION_DAYS = 30;

// Cookie lifetime in seconds, kept in step with the session lifetime.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * SESSION_DURATION_DAYS;

// ─────────────────────────────────────────────────────────────────────────────
// createSession(userId)
//
// Called after a successful login. Creates a new row in the session table and
// returns the random token that should be stored in the browser cookie.
//
// crypto.randomUUID() generates a cryptographically random UUID like:
//   "f47ac10b-58cc-4372-a567-0e02b2c3d479"
// This is unpredictable enough that an attacker cannot guess it.
// ─────────────────────────────────────────────────────────────────────────────

export async function createSession(userId: number): Promise<string> {
	const token = crypto.randomUUID();

	const expiresAt = new Date();
	expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);

	await db.insert(session).values({ id: token, userId, expiresAt });

	return token;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateSession(token)
//
// Called on every request by hooks.server.ts. Looks up the token in the
// session table. Returns the userId if the session exists and has not expired,
// or null if it is invalid/expired.
//
// Expired sessions are deleted immediately when discovered — this keeps the
// session table from accumulating stale rows over time.
// ─────────────────────────────────────────────────────────────────────────────

export async function validateSession(
	token: string
): Promise<{ userId: number; renewed: boolean } | null> {
	const [row] = await db.select().from(session).where(eq(session.id, token));

	if (!row) {
		// Token not found in the database — invalid or already deleted.
		return null;
	}

	if (row.expiresAt < new Date()) {
		// Token exists but has passed its expiry date — delete and reject.
		await db.delete(session).where(eq(session.id, token));
		return null;
	}

	// Sliding expiry: once less than half of the lifetime remains, push the
	// expiry out by a full lifetime. At most one write per half-lifetime.
	// `renewed` tells the caller to refresh the browser cookie as well.
	const now = Date.now();
	const halfLifetimeMs = (SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000) / 2;
	if (row.expiresAt.getTime() - now < halfLifetimeMs) {
		const expiresAt = new Date(now);
		expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);
		await db.update(session).set({ expiresAt }).where(eq(session.id, token));
		return { userId: row.userId, renewed: true };
	}

	return { userId: row.userId, renewed: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// deleteSession(token)
//
// Called on logout. Removes the session row from the database so the token
// is immediately invalid — even if the browser still has the cookie.
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteSession(token: string): Promise<void> {
	await db.delete(session).where(eq(session.id, token));
}
