-- 0034_reviewed_game_optional_repertoire.sql
-- reviewed_game.repertoire_id was NOT NULL because, until now, every row in
-- this table came from the deviation review workflow, which always has a
-- repertoire. Since migration 0033 (anti_gaffe_module) and the review page
-- decoupling that preceded it, a pasted game with no matching repertoire
-- still loads and can still be scanned for anti-gaffe candidates — but
-- there was previously no way to persist such a game at all (no
-- imported_game_id, and reviewed_game required a repertoire it doesn't
-- have). This migration removes that requirement.
--
-- Only two call sites read reviewed_game.repertoire_id (both verified
-- harmless with NULL): review/+page.server.ts's recentGames list (a
-- repertoire-less save simply doesn't appear when filtering by active
-- repertoire) and the cascade delete in api/repertoires/[id] (a
-- repertoire-less row is never touched by deleting some other repertoire).

ALTER TABLE reviewed_game ALTER COLUMN repertoire_id DROP NOT NULL;
