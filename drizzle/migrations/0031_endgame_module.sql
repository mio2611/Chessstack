-- 0031_endgame_module.sql
-- Endgame training module: independent of the opening repertoire DAG.
-- No move-tree, no transpositions — just a position, a category, and a
-- terminal objective (checkmate or draw). Correctness of moves played during
-- drill is validated live against the Lichess tablebase API
-- (tablebase.lichess.ovh), not against a stored "expected move" — no single
-- move is stored here, only the objective the position must resolve to.
--
-- Positions are sourced from supertorpe/chessendgametraining (GPL-3.0),
-- filtered at import time to 7 pieces or fewer (Syzygy tablebase coverage
-- limit). See scripts/endgame-import.py for the import/filter logic.

-- ─── Shared book table ────────────────────────────────────────────────────
-- Ships with the app as seed data, same pattern as book_position.

CREATE TABLE endgame_position (
	fen TEXT PRIMARY KEY, -- 4-field normalized FEN
	category TEXT NOT NULL, -- e.g. "Basic", "Pawn", "Rook-Pieces" (source's top-level grouping)
	subcategory TEXT NOT NULL, -- e.g. "Queen", "Rook vs Pawn" (source's second-level grouping)
	target TEXT NOT NULL, -- 'checkmate' | 'draw' — the terminal objective, not a move
	mate_in_hint INTEGER, -- informational only, from source data; not enforced during drill
	piece_count INTEGER NOT NULL, -- total pieces on board incl. kings; import filters this to <= 7
	source_attribution TEXT NOT NULL -- e.g. "chessendgametraining (GPL-3.0), github.com/supertorpe/chessendgametraining"
);

CREATE INDEX idx_endgame_position_category ON endgame_position(category, subcategory);

-- ─── User table: FSRS card state ──────────────────────────────────────────
-- Same field set and types as user_repertoire_move's FSRS columns, so
-- src/lib/fsrs.ts (gradeCard, buildReviewLogEntry) works against this table
-- without any changes — it already operates on a generic FSRSCardRow shape.

CREATE TABLE endgame_card (
	id SERIAL PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	fen TEXT NOT NULL REFERENCES endgame_position(fen) ON DELETE CASCADE,

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

CREATE INDEX idx_endgame_card_due ON endgame_card(due);
CREATE INDEX idx_endgame_card_user_id ON endgame_card(user_id);

-- ─── User table: FSRS review log ──────────────────────────────────────────
-- Deliberately a separate table from review_log, not a shared table with a
-- discriminant column. review_log.card_id has a hard FK to
-- user_repertoire_move(id), already in production (migration 0027). Loosening
-- that constraint to accommodate a second card domain would break an
-- invariant ("one review_log row = one grading event on exactly this card
-- type") for no immediate benefit — the FSRS weight optimizer this table
-- feeds is explicitly deferred. A combined view (UNION ALL) can be added
-- later if a cross-domain optimizer ever needs one, without touching either
-- table's physical schema.

CREATE TABLE endgame_review_log (
	id SERIAL PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	card_id INTEGER NOT NULL REFERENCES endgame_card(id) ON DELETE CASCADE,

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

CREATE INDEX idx_endgame_review_log_user_id ON endgame_review_log(user_id);
CREATE INDEX idx_endgame_review_log_card_id ON endgame_review_log(card_id);
