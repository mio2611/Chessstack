#!/usr/bin/env python3
from __future__ import annotations
"""
Endgame Import — Imports the supertorpe/chessendgametraining position catalogue
into the endgame_position table, filtered to Syzygy-coverable positions.

Source: https://github.com/supertorpe/chessendgametraining (GPL-3.0).
Fetched from a pinned commit, not a branch, so a later change or deletion
upstream cannot silently change what this script imports:
  https://raw.githubusercontent.com/supertorpe/chessendgametraining/<COMMIT>/code/src/static/endgamedatabase.json

The source file is a nested categories -> subcategories -> games structure.
Each game is only {fen, target: "checkmate"|"draw", mateIn?} — there is no
expected move in the source data. This script does NOT compute or store an
expected move: endgame_position.target is the terminal objective a drill
session must resolve to, validated move-by-move at drill time against the
Lichess tablebase API (see $lib/endgame/tablebase.ts, not this script).

Filtering: Syzygy tablebases cover positions with 7 pieces or fewer (kings
included). Positions above that are skipped entirely, not imported with a
degraded validation mode — see design discussion, kept out of the V1 catalogue
scope by choice, not by an oversight.

With --verify, each candidate position is probed against the Lichess
tablebase API to confirm the source's `target` label actually matches the
tablebase's WDL category before importing it. This catches source data errors
(mislabeled draws/wins) but is slow — one HTTP request per position, with a
deliberate delay between requests to stay well under any reasonable rate
limit on a public shared endpoint. Expect this to take a while over ~2900
positions; it is meant to be run once, off-NAS, not as part of any regular
pipeline (see explore/maia-validation for the established pattern: Python
validation scripts live in scripts/, never in Docker/CI).

Dependencies:
  pip install requests psycopg2-binary

Usage:
  # Dry run — filter, verify, but do not write to the database:
  python endgame-import.py --verify --dry-run

  # Full import, no tablebase verification (fast, trusts source labels):
  python endgame-import.py

  # Full import with tablebase verification (slow, recommended once before
  # trusting the catalogue long-term):
  python endgame-import.py --verify

Environment:
  DATABASE_URL  PostgreSQL connection string (required unless --dry-run)
"""

import argparse
import os
import sys
import time
from dataclasses import dataclass

import requests

SOURCE_COMMIT = "0ff395ac711f54969fd2009d9b3df416a0eae936"
SOURCE_URL = (
    f"https://raw.githubusercontent.com/supertorpe/chessendgametraining/"
    f"{SOURCE_COMMIT}/code/src/static/endgamedatabase.json"
)
SOURCE_ATTRIBUTION = (
    "chessendgametraining (GPL-3.0), "
    "github.com/supertorpe/chessendgametraining, "
    f"commit {SOURCE_COMMIT[:12]}"
)

TABLEBASE_URL = "https://tablebase.lichess.ovh/standard"
MAX_PIECES = 7

# Delay between tablebase requests in --verify mode. Conservative on purpose —
# this hits a free public endpoint shared with lichess.org itself.
TABLEBASE_DELAY_SECONDS = 1.0


@dataclass
class EndgamePosition:
	fen: str
	category: str
	subcategory: str
	target: str  # 'checkmate' | 'draw'
	mate_in_hint: int | None
	piece_count: int


def piece_count(fen: str) -> int:
	board_field = fen.split(" ")[0]
	return sum(1 for ch in board_field if ch.isalpha())


def normalize_fen_4field(fen: str) -> str:
	"""Match the fenKey() convention used throughout the app: keep board,
	active color, castling rights, en passant — drop halfmove/fullmove clocks,
	which don't affect the position for our purposes and would otherwise
	fragment identical positions into distinct rows."""
	fields = fen.split(" ")
	return " ".join(fields[:4])


def fetch_source_positions() -> list[EndgamePosition]:
	print(f"[endgame-import] fetching {SOURCE_URL}")
	resp = requests.get(SOURCE_URL, timeout=30)
	resp.raise_for_status()
	data = resp.json()

	positions: list[EndgamePosition] = []
	skipped_too_many_pieces = 0

	for category in data["categories"]:
		cat_name = category["name"]
		for subcategory in category["subcategories"]:
			sub_name = subcategory["name"]
			for game in subcategory["games"]:
				fen = normalize_fen_4field(game["fen"])
				n = piece_count(fen)
				if n > MAX_PIECES:
					skipped_too_many_pieces += 1
					continue
				positions.append(
					EndgamePosition(
						fen=fen,
						category=cat_name,
						subcategory=sub_name,
						target=game["target"],
						mate_in_hint=game.get("mateIn"),
						piece_count=n
					)
				)

	print(
		f"[endgame-import] {len(positions)} positions within {MAX_PIECES}-piece "
		f"limit, {skipped_too_many_pieces} skipped (too many pieces)"
	)
	return positions


TABLEBASE_MAX_ATTEMPTS = 4
TABLEBASE_RETRY_BASE_SECONDS = 2.0


def verify_against_tablebase(pos: EndgamePosition) -> bool:
	"""Returns True if the tablebase's WDL category agrees with the source's
	`target` label. 'win'/'cursed-win' count as agreeing with a checkmate
	target (the position is winning; the source's specific label is about the
	eventual forced outcome, tablebase category is the WDL classification of
	the side to move). 'draw'/'blessed-loss' agree with a draw target only in
	the literal draw case — blessed-loss is a draw under the 50-move rule
	from a technically lost position, which does not match a 'draw' target
	claim, so it is treated as a mismatch on purpose.

	Retries transient network/connection failures (timeouts, SSL resets,
	5xx) with exponential backoff before giving up on a position — over
	~2900 sequential requests, a handful of one-off connection failures is
	expected on any network and should not be indistinguishable from a
	genuine tablebase disagreement. A raised exception after all attempts
	means the caller should skip the position, not treat it as a mismatch.
	"""
	last_exc: requests.RequestException | None = None
	for attempt in range(1, TABLEBASE_MAX_ATTEMPTS + 1):
		try:
			resp = requests.get(TABLEBASE_URL, params={"fen": pos.fen}, timeout=15)
			resp.raise_for_status()
			category = resp.json().get("category")

			if pos.target == "checkmate":
				return category in ("win", "maybe-win", "cursed-win")
			if pos.target == "draw":
				return category == "draw"
			return False
		except requests.RequestException as exc:
			last_exc = exc
			if attempt < TABLEBASE_MAX_ATTEMPTS:
				delay = TABLEBASE_RETRY_BASE_SECONDS * (2 ** (attempt - 1))
				print(
					f"[endgame-import] retry {attempt}/{TABLEBASE_MAX_ATTEMPTS - 1} "
					f"for {pos.fen} after {exc.__class__.__name__}, waiting {delay:.0f}s"
				)
				time.sleep(delay)

	assert last_exc is not None
	raise last_exc


def import_positions(positions: list[EndgamePosition], verify: bool, dry_run: bool) -> None:
	verified_count = 0
	mismatch_count = 0
	kept: list[EndgamePosition] = []

	for i, pos in enumerate(positions):
		if verify:
			try:
				ok = verify_against_tablebase(pos)
			except requests.RequestException as exc:
				print(f"[endgame-import] WARNING: tablebase lookup failed for {pos.fen}: {exc}")
				# Conservative default: do not import a position we failed to verify.
				continue
			time.sleep(TABLEBASE_DELAY_SECONDS)
			if not ok:
				mismatch_count += 1
				print(f"[endgame-import] MISMATCH, skipping: {pos.fen} (source target={pos.target})")
				continue
			verified_count += 1

		kept.append(pos)

		if (i + 1) % 100 == 0:
			print(f"[endgame-import] processed {i + 1}/{len(positions)}")

	print(f"[endgame-import] {len(kept)} positions to import")
	if verify:
		print(f"[endgame-import] {verified_count} verified, {mismatch_count} mismatched and dropped")

	if dry_run:
		print("[endgame-import] --dry-run, not writing to database")
		return

	import psycopg2
	from psycopg2.extras import execute_values

	db_url = os.environ.get("DATABASE_URL")
	if not db_url:
		print("[endgame-import] ERROR: DATABASE_URL environment variable is required")
		sys.exit(1)

	conn = psycopg2.connect(db_url)
	try:
		with conn.cursor() as cur:
			execute_values(
				cur,
				"""
				INSERT INTO endgame_position
					(fen, category, subcategory, target, mate_in_hint, piece_count, source_attribution)
				VALUES %s
				ON CONFLICT (fen) DO NOTHING
				""",
				[
					(p.fen, p.category, p.subcategory, p.target, p.mate_in_hint, p.piece_count, SOURCE_ATTRIBUTION)
					for p in kept
				]
			)
		conn.commit()
		print(f"[endgame-import] committed {len(kept)} positions (duplicates skipped via ON CONFLICT)")
	finally:
		conn.close()


def main() -> None:
	parser = argparse.ArgumentParser(description="Import chessendgametraining catalogue into endgame_position")
	parser.add_argument(
		"--verify",
		action="store_true",
		help="Cross-check each position's target against the Lichess tablebase API before importing (slow)"
	)
	parser.add_argument(
		"--dry-run",
		action="store_true",
		help="Fetch, filter, and (optionally) verify, but do not write to the database"
	)
	parser.add_argument(
		"--limit",
		type=int,
		default=None,
		help="Only process the first N positions after piece-count filtering — for testing the database write path quickly before a full run"
	)
	args = parser.parse_args()

	positions = fetch_source_positions()
	if args.limit is not None:
		positions = positions[: args.limit]
		print(f"[endgame-import] --limit {args.limit}: processing only the first {len(positions)} positions")
	import_positions(positions, verify=args.verify, dry_run=args.dry_run)


if __name__ == "__main__":
	main()
