-- 0029_repertoire_hierarchy.sql
-- Add parent_repertoire_id to repertoire.
-- NULL = primary repertoire (e.g. "White - e4", "White - d4", "Black - e5").
-- Non-null = secondary repertoire attached to that primary; its startFen
-- marks where it branches off the primary's tree.
-- ON DELETE RESTRICT: a primary cannot be deleted while secondaries exist,
-- to avoid silently orphaning or cascading away FSRS review history.

ALTER TABLE repertoire ADD COLUMN parent_repertoire_id INTEGER REFERENCES repertoire(id) ON DELETE RESTRICT;
CREATE INDEX idx_repertoire_parent_id ON repertoire (parent_repertoire_id);