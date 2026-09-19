-- 0033_anti_gaffe_module.sql
-- Anti-gaffe training module: positions extracted from the user's own played
-- games (imported via Lichess/Chess.com, or reviewed from a pasted PGN)
-- where a move lost >= 100 centipawns — the same mistake+blunder threshold
-- already used by review's CPL classification — in a position that wasn't
-- already decided (eval before the move within [-300, +300]cp). Evaluated
-- client-side (see $lib/client/stockfish), same engine and depth as review.
--
-- Independent of the opening repertoire DAG and of the endgame module.
-- Unlike endgame_position, there is no shared seed table: every candidate
-- is personal, discovered by scanning one specific game of one specific
-- user — see anti_gaffe_candidate below.

-- ─── Staging: scan candidates awaiting review ─────────────────────────────
-- One row per position where a scan found a >=100cp loss. Exactly one of
-- imported_game_id / reviewed_game_id is set — a game can come from either
-- source (imported_game for Lichess/Chess.com games, reviewed_game to also
-- cover games pasted manually as MANUAL, which never go through
-- imported_game at all).

CREATE TABLE anti_gaffe_candidate (
	id SERIAL PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

	imported_game_id INTEGER REFERENCES imported_game(id) ON DELETE CASCADE,
	reviewed_game_id INTEGER REFERENCES reviewed_game(id) ON DELETE CASCADE,

	ply INTEGER NOT NULL, -- index into the game's fenHistory (0 = starting position)
	fen TEXT NOT NULL, -- 4-field normalized FEN, the position BEFORE the mistake
	played_san TEXT NOT NULL, -- the move actually played
	eval_before_cp INTEGER NOT NULL, -- white-perspective eval before the move
	eval_after_cp INTEGER NOT NULL, -- white-perspective eval after the move actually played
	cp_loss INTEGER NOT NULL, -- >= 100 by construction (the scan's own filter)
	best_move_uci TEXT, -- engine's suggested best move from the scan, informational
	best_move_san TEXT, -- same, in SAN

	status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected'
	confirmed_move_san TEXT, -- set at accept time; defaults to best_move_san, editable
	card_id INTEGER, -- set at accept time — see anti_gaffe_card below (FK added after that table exists)

	created_at TIMESTAMP NOT NULL,
	reviewed_at TIMESTAMP, -- when status left 'pending'

	CONSTRAINT anti_gaffe_candidate_one_source CHECK (
		(imported_game_id IS NOT NULL)::int + (reviewed_game_id IS NOT NULL)::int = 1
	)
);

CREATE INDEX idx_anti_gaffe_candidate_user_status ON anti_gaffe_candidate(user_id, status);
CREATE INDEX idx_anti_gaffe_candidate_imported_game ON anti_gaffe_candidate(imported_game_id);
CREATE INDEX idx_anti_gaffe_candidate_reviewed_game ON anti_gaffe_candidate(reviewed_game_id);

-- ─── User table: FSRS card state ──────────────────────────────────────────
-- One card per (user, position) — never per candidate/occurrence: review is
-- against a position, not an event, so the same mistake recurring across
-- games attaches multiple candidates to the same card rather than creating
-- duplicates. Same field set/types as endgame_card / user_repertoire_move's
-- FSRS columns, so $lib/fsrs.ts works against this table unchanged.

CREATE TABLE anti_gaffe_card (
	id SERIAL PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,

	fen TEXT NOT NULL,
	confirmed_move_san TEXT NOT NULL, -- the move to find during drill

	due TIMESTAMP,
	stability DOUBLE PRECISION,
	difficulty DOUBLE PRECISION,
	elapsed_days INTEGER,
	scheduled_days INTEGER,
	reps INTEGER,
	lapses INTEGER,
	state INTEGER, -- 0=New, 1=Learning, 2=Review, 3=Relearning
	last_review TIMESTAMP,
	learning_steps INTEGER NOT NULL DEFAULT 0,

	UNIQUE(user_id, fen)
);

CREATE INDEX idx_anti_gaffe_card_due ON anti_gaffe_card(due);
CREATE INDEX idx_anti_gaffe_card_user_id ON anti_gaffe_card(user_id);

ALTER TABLE anti_gaffe_candidate
	ADD CONSTRAINT anti_gaffe_candidate_card_id_fkey
	FOREIGN KEY (card_id) REFERENCES anti_gaffe_card(id) ON DELETE SET NULL;

CREATE INDEX idx_anti_gaffe_candidate_card_id ON anti_gaffe_candidate(card_id);

-- ─── User table: FSRS review log ──────────────────────────────────────────
-- Deliberately a separate table from review_log and endgame_review_log, not
-- a shared table with a discriminant column — same reasoning as
-- endgame_review_log's own comment (migration 0031): a hard FK per card
-- domain, no cross-domain optimizer yet needed.

CREATE TABLE anti_gaffe_review_log (
	id SERIAL PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	card_id INTEGER NOT NULL REFERENCES anti_gaffe_card(id) ON DELETE CASCADE,

	rating INTEGER NOT NULL, -- 1=Again, 3=Good, 4=Easy
	reviewed_at TIMESTAMP NOT NULL,

	state_before INTEGER NOT NULL,
	stability_before DOUBLE PRECISION,
	difficulty_before DOUBLE PRECISION,
	elapsed_days_before INTEGER,
	scheduled_days_before INTEGER,
	learning_steps_before INTEGER NOT NULL,

	state_after INTEGER NOT NULL,
	stability_after DOUBLE PRECISION NOT NULL,
	difficulty_after DOUBLE PRECISION NOT NULL,
	elapsed_days_after INTEGER NOT NULL,
	scheduled_days_after INTEGER NOT NULL,
	learning_steps_after INTEGER NOT NULL,

	request_retention DOUBLE PRECISION NOT NULL
);

CREATE INDEX idx_anti_gaffe_review_log_user_id ON anti_gaffe_review_log(user_id);
CREATE INDEX idx_anti_gaffe_review_log_card_id ON anti_gaffe_review_log(card_id);

-- ─── Independent scan markers ──────────────────────────────────────────────
-- Deliberately separate from imported_game.status ('pending'/'reviewed'/
-- 'skipped'), which tracks the deviation workflow only. A game can be
-- deviation-reviewed and never anti-gaffe-scanned, or the reverse. Set when
-- a scan finishes, whether or not it produced any candidates — a clean
-- game is still "scanned", not "untouched".

ALTER TABLE imported_game ADD COLUMN anti_gaffe_scanned_at TIMESTAMP;
ALTER TABLE reviewed_game ADD COLUMN anti_gaffe_scanned_at TIMESTAMP;
