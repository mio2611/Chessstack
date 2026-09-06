-- Track when a trainer session's Stockfish evaluation was cut short by the
-- timeout before completion (bestmove never received). When true:
--   - trainerRating was NOT adjusted from this session's eval, regardless of
--     the `rated` flag the client requested (see api/train/evaluate).
--   - finalEvalCp may still hold a partial-depth value, kept for diagnostic
--     purposes only; do not treat it as equivalent to a completed eval.
ALTER TABLE trainer_session ADD COLUMN eval_unreliable boolean NOT NULL DEFAULT false;
