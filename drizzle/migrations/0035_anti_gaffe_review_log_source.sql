-- 0035_anti_gaffe_review_log_source.sql
-- Same oversight as migration 0032 (endgame_review_log): buildReviewLogEntry()
-- in $lib/fsrs.ts always returns a `source` field, but anti_gaffe_review_log
-- (migration 0033) was never given a matching column. anti_gaffe_review_log
-- has no rows in any environment yet (no drill UI existed until now), so
-- this is a plain additive column, not a backfill — no default needed.

ALTER TABLE anti_gaffe_review_log ADD COLUMN source TEXT NOT NULL;
