-- 0036_drop_stockfish_settings.sql
-- stockfish_depth and stockfish_timeout on user_settings had a single
-- consumer: /api/train/evaluate. That endpoint now uses fixed constants
-- (TRAIN_EVAL_DEPTH, TRAIN_EVAL_WATCHDOG_MS) with a progress-based watchdog
-- instead of a fixed wall-clock timeout, matching the pattern already used
-- for the anti-gaffe scan. A rating-affecting evaluation should not be a
-- user-adjustable knob, and no other code path read these columns
-- (verified: only 0000_create_tables.sql referenced them besides the
-- removed call sites). Settings UI sliders and the /api/settings PATCH
-- handling for both fields were removed in the same change.

ALTER TABLE user_settings DROP COLUMN stockfish_depth;
ALTER TABLE user_settings DROP COLUMN stockfish_timeout;
