-- Fix: endgame_review_log was missing the `source` column present on
-- review_log (see review_log's own comment: "DRILL" or "REVIEW_DEVIATION").
-- buildReviewLogEntry() in $lib/fsrs.ts always returns a `source` field —
-- omitting it here was an oversight in migration 0031, not a deliberate
-- simplification. endgame_review_log has no rows in any environment yet (no
-- drill UI existed at the time 0031 shipped), so this is a plain additive
-- column, not a backfill.
ALTER TABLE endgame_review_log ADD COLUMN source text NOT NULL DEFAULT 'ENDGAME_PRACTICE';
ALTER TABLE endgame_review_log ALTER COLUMN source DROP DEFAULT;
