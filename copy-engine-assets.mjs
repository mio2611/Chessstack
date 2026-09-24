// Copies the Stockfish WASM engine (lite, single-threaded build) from
// node_modules into static/engine/ so SvelteKit serves it as a static asset.
//
// Runs automatically before `npm run build` (see the "prebuild" script in
// package.json) — never committed to git, same convention as the seed data
// dumps (*.sql.gz), which are fetched rather than checked in.
//
// Why this specific build: see /docs or the project notes for the tradeoff
// between the "lite" (~1.6MB, no special headers) and "large" (~94MB,
// requires COOP/COEP) engines. Lite single-thread was chosen deliberately.

import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_FILES = ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm'];

const srcDir = path.join(__dirname, 'node_modules', 'stockfish', 'bin');
const destDir = path.join(__dirname, 'static', 'engine');

mkdirSync(destDir, { recursive: true });

for (const file of ENGINE_FILES) {
	copyFileSync(path.join(srcDir, file), path.join(destDir, file));
}

console.log(`[copy-engine-assets] Copied ${ENGINE_FILES.length} file(s) to static/engine/`);
