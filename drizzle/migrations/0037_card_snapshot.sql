-- 0037_card_snapshot.sql
-- Add card_snapshot: one row per user, repertoire and local calendar day, with
-- the number of in-scope cards and the number of "struggling" cards (the red
-- dot on the Build graph: 3 or more lapses and not mature).
--
-- Neither number can be reconstructed after the fact: user_repertoire_move has
-- no creation date and review_log has no lapse counter, so this table only
-- accumulates from the day it is deployed. The row of the current day is
-- overwritten each time it is refreshed (last write of the day wins).
--
-- day is the viewer's local day as YYYY-MM-DD text (tz cookie), the same
-- convention as the other /stats aggregates.

CREATE TABLE card_snapshot (
	id SERIAL PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	repertoire_id INTEGER NOT NULL REFERENCES repertoire(id) ON DELETE CASCADE,
	day TEXT NOT NULL,
	total_cards INTEGER NOT NULL,
	struggling_cards INTEGER NOT NULL,
	updated_at TIMESTAMP NOT NULL,
	CONSTRAINT card_snapshot_user_id_repertoire_id_day_unique UNIQUE (user_id, repertoire_id, day)
);

CREATE INDEX idx_card_snapshot_repertoire_id ON card_snapshot(repertoire_id);
