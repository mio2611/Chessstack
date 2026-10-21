// PGN variation tree parser — walks mainline + all parenthetical variations
// and replays each line through Chess.js to produce FEN-keyed edges.
//
// Chess.js's loadPgn() silently drops variations, so we need a custom
// tokenizer that understands PGN nesting, then replay for FEN computation.
//
// Annotations: PGN comments {like this} are preserved and attached to the
// preceding move as `annotation`. Engine-specific tags like [%evp ...] and
// [%cal ...] are filtered out since they're not human-readable.
//
// A file can hold several games. The text is scanned once, left to right, so a
// bracket inside a header value or a comment can never be mistaken for the
// start or end of something else. Each game is replayed from the standard
// starting position and the edges of all games are merged.

import { Chess } from 'chess.js';
import { fenKey, STARTING_FEN } from '$lib/fen';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single edge in the repertoire tree extracted from a PGN. */
export interface PgnEdge {
	fromFen: string;
	toFen: string;
	san: string;
	isUserTurn: boolean;
	/** Human-readable annotation from PGN comments, or null. */
	annotation: string | null;
}

// Internal: a node in the parsed move tree.
interface MoveNode {
	san: string;
	comment: string | null; // annotation text following this move
	variations: MoveNode[][]; // alternative continuations from the SAME position as this move
}

// ─── Comment cleaning ───────────────────────────────────────────────────────

/** Prefix used to mark comment tokens in the token stream. */
const COMMENT_PREFIX = '\x00CMT:';

/**
 * Clean a raw PGN comment into a human-readable annotation.
 * Strips engine tags like [%evp ...], [%cal ...], [%csl ...].
 * Returns null if nothing meaningful remains.
 */
function cleanComment(raw: string): string | null {
	let text = raw;

	// Remove engine-specific tags: [%evp 0,15,...], [%cal Re2e4], [%csl Gf3], etc.
	text = text.replace(/\[%[^\]]*\]/g, '');

	// Collapse whitespace and trim
	text = text.replace(/\s+/g, ' ').trim();

	return text.length > 0 ? text : null;
}

// ─── Scanner ────────────────────────────────────────────────────────────────

/** One game of a PGN file, as a flat token stream. */
interface ParsedGame {
	/** SAN moves, '(' and ')', and comment tokens (prefixed with COMMENT_PREFIX). */
	tokens: string[];
	/** True once the game has at least one move. */
	hasMoves: boolean;
	/** True when the game starts from a custom position (SetUp / FEN header). */
	customStart: boolean;
	/** Problems met while scanning (e.g. a comment that is never closed). */
	problems: string[];
}

function newGame(): ParsedGame {
	return { tokens: [], hasMoves: false, customStart: false, problems: [] };
}

// A header line: one or more [Name "value"] tags. The value is a quoted string,
// so it may contain ']' or '[' freely; only an unescaped quote ends it.
// Sticky: matched only at the exact position being scanned.
const TAG_AT = /[ \t]*\[[A-Za-z0-9_]+[ \t]+"(?:[^"\\\r\n]|\\.)*"[ \t]*\]/y;
const END_OF_LINE = /[ \t]*(?:\r?\n|$)/y;
const TAG = /\[([A-Za-z0-9_]+)[ \t]+"((?:[^"\\\r\n]|\\.)*)"[ \t]*\]/g;

// Replaying a move through Chess.js costs roughly 100 µs, and it runs on the
// server's single thread: a file is bounded by its number of moves, not by its
// size in bytes. Beyond this, refuse with a clear message rather than freeze the
// app for a minute. ~150 000 moves is about 15 s of work.
const MAX_MOVES = 150_000;

const RESULT_MARKERS = new Set(['1-0', '0-1', '1/2-1/2', '*']);
const STANDARD_PLACEMENT = STARTING_FEN.split(' ')[0];

/**
 * The header line starting at `start` (one or more tags, then the end of the
 * line), or null when there is none. Tags are matched one at a time rather than
 * with a repeated group, which keeps the matching linear on any input.
 */
function matchHeaderLine(text: string, start: number): string | null {
	let pos = start;
	let tags = 0;
	for (;;) {
		TAG_AT.lastIndex = pos;
		const m = TAG_AT.exec(text);
		if (!m) break;
		pos += m[0].length;
		tags++;
	}
	if (tags === 0) return null;
	END_OF_LINE.lastIndex = pos;
	const end = END_OF_LINE.exec(text);
	if (!end) return null;
	return text.slice(start, pos + end[0].length);
}

function applyHeaders(game: ParsedGame, headerLine: string): void {
	for (const m of headerLine.matchAll(TAG)) {
		const name = m[1].toLowerCase();
		const value = m[2];
		if (name === 'setup' && value === '1') game.customStart = true;
		if (name === 'fen' && value.split(' ')[0] !== STANDARD_PLACEMENT) game.customStart = true;
	}
}

function isWordBreak(ch: string): boolean {
	return (
		ch === ' ' ||
		ch === '\t' ||
		ch === '\n' ||
		ch === '\r' ||
		ch === '{' ||
		ch === '(' ||
		ch === ')' ||
		ch === ';'
	);
}

/**
 * Scan PGN text into games. A new game starts at a header that follows moves,
 * or after a result marker (1-0, 0-1, 1/2-1/2, *) outside any variation.
 * Strips headers, NAGs, move numbers and result markers; comments and
 * variation parentheses become tokens.
 */
function scanGames(text: string): ParsedGame[] {
	const games: ParsedGame[] = [];
	let game = newGame();
	let depth = 0; // parenthesis depth: a result marker only ends a game at depth 0
	let moveCount = 0;
	let i = 0;
	let lineStart = true;

	const endGame = () => {
		if (game.hasMoves) games.push(game);
		game = newGame();
		depth = 0;
	};

	while (i < text.length) {
		if (lineStart) {
			lineStart = false;

			// Header line (only recognised at the start of a line).
			const header = matchHeaderLine(text, i);
			if (header !== null) {
				if (game.hasMoves) endGame();
				applyHeaders(game, header);
				i += header.length;
				lineStart = true; // the header consumed its newline
				continue;
			}

			// PGN escape line: ignored.
			if (text[i] === '%') {
				const nl = text.indexOf('\n', i);
				i = nl === -1 ? text.length : nl + 1;
				lineStart = true;
				continue;
			}
		}

		const c = text[i];

		if (c === '\n') {
			lineStart = true;
			i++;
			continue;
		}
		if (c === ' ' || c === '\t' || c === '\r') {
			i++;
			continue;
		}

		// {comment}: runs to the next '}', brackets inside are just text.
		if (c === '{') {
			const end = text.indexOf('}', i + 1);
			if (end === -1) {
				game.problems.push('Unterminated comment: the rest of the text was ignored');
				game.tokens.push(COMMENT_PREFIX + text.slice(i + 1));
				i = text.length;
			} else {
				game.tokens.push(COMMENT_PREFIX + text.slice(i + 1, end));
				i = end + 1;
			}
			continue;
		}

		// ;comment: runs to the end of the line.
		if (c === ';') {
			const nl = text.indexOf('\n', i);
			const end = nl === -1 ? text.length : nl;
			game.tokens.push(COMMENT_PREFIX + text.slice(i + 1, end));
			i = end;
			continue;
		}

		if (c === '(') {
			depth++;
			game.tokens.push('(');
			i++;
			continue;
		}
		if (c === ')') {
			depth = Math.max(0, depth - 1);
			game.tokens.push(')');
			i++;
			continue;
		}

		// A word: a move, a move number, a NAG or a result marker.
		let j = i;
		while (j < text.length && !isWordBreak(text[j])) j++;
		const word = text.slice(i, j);
		i = j;

		if (/^\$\d+$/.test(word)) continue; // NAG: $1, $2...
		if (RESULT_MARKERS.has(word)) {
			if (depth === 0) endGame();
			continue;
		}

		// Drop a leading move number ("1.", "12...", "1.e4") and !? glyphs.
		const san = word.replace(/^\d+\.+/, '').replace(/[!?]+/g, '');
		if (!san) continue;

		if (++moveCount > MAX_MOVES) {
			throw new Error(
				`PGN is too large: more than ${MAX_MOVES.toLocaleString('en-US')} moves. Split it into smaller files.`
			);
		}
		game.tokens.push(san);
		game.hasMoves = true;
	}

	if (game.hasMoves) games.push(game);
	return games;
}

/**
 * Parse a flat token stream into a tree of MoveNodes.
 *
 * The key PGN rule: a variation `(...)` is an alternative to the move
 * IMMEDIATELY BEFORE the opening paren. It branches from the position
 * that existed before that move was played.
 *
 * Comment tokens (COMMENT_PREFIX) are attached to the preceding move node.
 */
function buildTree(tokens: string[]): { nodes: MoveNode[]; leftover: number } {
	let pos = 0;

	function parseLine(): MoveNode[] {
		const nodes: MoveNode[] = [];

		while (pos < tokens.length) {
			const token = tokens[pos];

			if (token === ')') {
				// End of current variation — don't consume the ')' here,
				// let the caller handle it.
				break;
			}

			if (token.startsWith(COMMENT_PREFIX)) {
				// Comment token — attach to the preceding move (if any)
				if (nodes.length > 0) {
					const cleaned = cleanComment(token.slice(COMMENT_PREFIX.length));
					if (cleaned && !nodes[nodes.length - 1].comment) {
						nodes[nodes.length - 1].comment = cleaned;
					}
				}
				pos++;
			} else if (token === '(') {
				// Start of a variation: alternative to the LAST move in `nodes`.
				pos++; // consume '('
				const variation = parseLine();
				pos++; // consume ')'

				// Attach the variation to the preceding move node.
				// If there's no preceding move (variation at start), skip it.
				if (nodes.length > 0) {
					nodes[nodes.length - 1].variations.push(variation);
				}
			} else {
				// It's a SAN move token.
				nodes.push({ san: token, comment: null, variations: [] });
				pos++;
			}
		}

		return nodes;
	}

	// A ')' with no matching '(' stops the parse early: report how much was left.
	const nodes = parseLine();
	return { nodes, leftover: tokens.length - pos };
}

// ─── Replay ─────────────────────────────────────────────────────────────────

/**
 * Walk the move tree recursively, replaying through Chess.js to compute FENs.
 * Collects edges and any errors (illegal moves).
 */
function replayTree(
	nodes: MoveNode[],
	startFen: string,
	repertoireColor: 'WHITE' | 'BLACK',
	edges: Map<string, PgnEdge>,
	errors: string[],
	moveContext: string[] // for error messages, e.g. ["1.d4", "Nf6", "2.Nc3"]
): void {
	const chess = new Chess(startFen);

	for (const node of nodes) {
		const fromFen = fenKey(chess.fen());

		// Try to play the move
		let result;
		try {
			result = chess.move(node.san);
		} catch {
			// Illegal move — skip this node and everything after it in this line.
			errors.push(`Invalid move '${node.san}' after ${moveContext.join(' ') || 'start position'}`);
			return;
		}

		if (!result) {
			errors.push(`Invalid move '${node.san}' after ${moveContext.join(' ') || 'start position'}`);
			return;
		}

		const toFen = fenKey(chess.fen());
		const san = result.san; // Use Chess.js's normalized SAN

		// Determine if this is the user's turn
		const fenTurn = fromFen.split(' ')[1]; // 'w' or 'b'
		const isUserTurn =
			(repertoireColor === 'WHITE' && fenTurn === 'w') ||
			(repertoireColor === 'BLACK' && fenTurn === 'b');

		// Deduplicate by fenKey + san (transpositions produce identical edges).
		// Keep the first annotation found — don't overwrite with null.
		const edgeKey = fenKey(fromFen) + '|' + san;
		const existing = edges.get(edgeKey);
		if (!existing) {
			edges.set(edgeKey, { fromFen, toFen, san, isUserTurn, annotation: node.comment });
		} else if (!existing.annotation && node.comment) {
			existing.annotation = node.comment;
		}

		const newContext = [...moveContext, san];

		// Process variations BEFORE continuing the mainline.
		// Each variation branches from `fromFen` (the position before this move).
		for (const variation of node.variations) {
			replayTree(variation, fromFen, repertoireColor, edges, errors, moveContext);
		}

		// Update context for the next move in this line
		moveContext = newContext;
	}
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse a PGN string with variations and produce a deduplicated list of
 * repertoire edges (fromFen → toFen via san).
 *
 * The text may hold several games: each is replayed from the standard starting
 * position and their edges are merged. A game that starts from a custom
 * position is skipped with a message (the file is refused only when no game
 * can be imported). With several games, messages are prefixed "Game N: ".
 *
 * Handles nested variations of arbitrary depth. Invalid moves within a
 * variation skip that sub-line and collect an error message.
 *
 * PGN comments are preserved as annotations on edges. Engine-specific
 * tags like [%evp ...] are stripped.
 */
export function parseVariationPgn(
	rawPgn: string,
	repertoireColor: 'WHITE' | 'BLACK'
): { edges: PgnEdge[]; errors: string[] } {
	const pgn = rawPgn.replace(/^\uFEFF/, '').trim();
	if (!pgn) throw new Error('PGN is empty');

	const games = scanGames(pgn);
	if (games.length === 0) throw new Error('PGN contains no moves');

	const multi = games.length > 1;
	const edges = new Map<string, PgnEdge>();
	const errors: string[] = [];
	let imported = 0;

	games.forEach((game, idx) => {
		const label = multi ? `Game ${idx + 1}: ` : '';

		if (game.customStart) {
			errors.push(`${label}skipped, custom starting positions are not supported`);
			return;
		}
		imported++;

		for (const problem of game.problems) errors.push(label + problem);

		const { nodes, leftover } = buildTree(game.tokens);
		if (leftover > 0) {
			errors.push(`${label}unmatched ')', the rest of the game was ignored`);
		}

		const gameErrors: string[] = [];
		replayTree(nodes, STARTING_FEN, repertoireColor, edges, gameErrors, []);
		for (const message of gameErrors) errors.push(label + message);
	});

	if (imported === 0) {
		throw new Error(
			'Custom starting positions are not supported — only standard games can be imported'
		);
	}

	return { edges: Array.from(edges.values()), errors };
}
