// Downloads the Stockfish WASM engine (lite, single-threaded build) directly
// from the npm registry tarball and extracts it into static/engine/, so
// SvelteKit serves it as a static asset — without installing the full
// stockfish npm package (~200MB, includes two ~99MB multi-threaded WASM
// builds we never use, which was crashing `npm ci` under QEMU arm64
// emulation in CI).
//
// Runs automatically before `npm run build` (see the "prebuild" script in
// package.json) — never committed to git, same convention as the seed data
// dumps (*.sql.gz), which are fetched rather than checked in.
//
// Why this specific build: see /docs or the project notes for the tradeoff
// between the "lite" (~1.6MB, no special headers) and "large" (~94MB,
// requires COOP/COEP) engines. Lite single-thread was chosen deliberately.

import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { extract } from 'tar-stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOCKFISH_VERSION = '19.0.0';
const TARBALL_URL = `https://registry.npmjs.org/stockfish/-/stockfish-${STOCKFISH_VERSION}.tgz`;
const ENGINE_FILES = new Set(['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']);

const destDir = path.join(__dirname, 'static', 'engine');
mkdirSync(destDir, { recursive: true });

const res = await fetch(TARBALL_URL);
if (!res.ok) {
	throw new Error(`Failed to fetch Stockfish tarball: ${res.status} ${res.statusText}`);
}

const ex = extract();
let copied = 0;

ex.on('entry', (header, stream, next) => {
	const basename = path.basename(header.name);
	if (ENGINE_FILES.has(basename)) {
		const out = createWriteStream(path.join(destDir, basename));
		stream.pipe(out);
		stream.on('end', () => {
			copied++;
			next();
		});
	} else {
		// Discard without writing to disk.
		stream.resume();
		stream.on('end', next);
	}
});

await pipeline(res.body, zlib.createGunzip(), ex);

if (copied !== ENGINE_FILES.size) {
	throw new Error(
		`Expected ${ENGINE_FILES.size} engine file(s), found ${copied}. ` +
			`Check that ENGINE_FILES matches the file names inside stockfish@${STOCKFISH_VERSION}.`
	);
}

console.log(`[copy-engine-assets] Downloaded and extracted ${copied} file(s) to static/engine/`);
