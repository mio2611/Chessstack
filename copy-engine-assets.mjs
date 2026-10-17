// Downloads the Stockfish WASM engine (lite, single-threaded build) directly
// from the npm registry tarball and extracts it into static/engine/, so
// SvelteKit serves it as a static asset — without installing the full
// stockfish npm package (~200MB, includes two ~99MB multi-threaded WASM
// builds we never use, which was crashing `npm ci` under QEMU arm64
// emulation in CI).
//
// Runs automatically before `npm run build` (see the "prebuild" script in
// package.json) — never committed to git, same convention as the seed data
// dumps (*.sql.gz), which are fetched rather than checked in. Any failure
// here aborts the build.
//
// The tarball is verified against the pinned npm integrity hash below (the
// same sha512 that package-lock.json would hold for it) before anything is
// written to static/engine/. When bumping STOCKFISH_VERSION, update
// TARBALL_INTEGRITY with `npm view stockfish@<version> dist.integrity`, and
// the file names and size floors in ENGINE_FILES if they changed.
//
// Why this specific build: the "lite" build (~1.6MB) needs no special
// headers, whereas the "large" one (~94MB) requires COOP/COEP. Lite
// single-thread was chosen deliberately; see the header of
// src/lib/client/stockfish.ts.

import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { extract } from 'tar-stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOCKFISH_VERSION = '19.0.0';
const TARBALL_URL = `https://registry.npmjs.org/stockfish/-/stockfish-${STOCKFISH_VERSION}.tgz`;
const TARBALL_INTEGRITY =
	'sha512-jDyYLbqNpboQcMs5HodTHI2CrKL74zkQWb1+sgoNXw5HI6avTblW4G0X7afFt3BBOc6VbTSkOV64EUxm/DWSpg==';

// File name -> minimum size in bytes. The floor catches an empty or truncated
// file that the integrity check could not (it covers the tarball, not the
// write to disk).
const ENGINE_FILES = new Map([
	['stockfish-19-lite-single.js', 1_000],
	['stockfish-19-lite-single.wasm', 1_000_000]
]);

const destDir = path.join(__dirname, 'static', 'engine');
const staticDir = path.dirname(destDir);
mkdirSync(staticDir, { recursive: true });

// Extract into a scratch directory on the same filesystem, and only move the
// files into static/engine/ once the tarball hash and file sizes are verified.
const tmpDir = mkdtempSync(path.join(staticDir, '.engine-tmp-'));

try {
	const res = await fetch(TARBALL_URL);
	if (!res.ok) {
		throw new Error(`Failed to fetch Stockfish tarball: ${res.status} ${res.statusText}`);
	}

	const hash = createHash('sha512');
	const hashTap = new Transform({
		transform(chunk, _enc, cb) {
			hash.update(chunk);
			cb(null, chunk);
		}
	});

	const ex = extract();
	const written = [];

	ex.on('entry', (header, stream, next) => {
		const basename = path.basename(header.name);
		if (ENGINE_FILES.has(basename)) {
			const out = createWriteStream(path.join(tmpDir, basename));
			stream.pipe(out);
			// Count a file only once it is fully flushed to disk.
			finished(out).then(
				() => {
					written.push(basename);
					next();
				},
				(err) => ex.destroy(err)
			);
		} else {
			// Discard without writing to disk.
			stream.resume();
			stream.on('end', next);
		}
	});

	await pipeline(Readable.fromWeb(res.body), hashTap, zlib.createGunzip(), ex);

	const actualIntegrity = `sha512-${hash.digest('base64')}`;
	if (actualIntegrity !== TARBALL_INTEGRITY) {
		throw new Error(
			`Integrity check failed for stockfish@${STOCKFISH_VERSION}: ` +
				`expected ${TARBALL_INTEGRITY}, got ${actualIntegrity}.`
		);
	}

	if (written.length !== ENGINE_FILES.size) {
		throw new Error(
			`Expected ${ENGINE_FILES.size} engine file(s), found ${written.length}. ` +
				`Check that ENGINE_FILES matches the file names inside stockfish@${STOCKFISH_VERSION}.`
		);
	}

	for (const [name, minBytes] of ENGINE_FILES) {
		const size = statSync(path.join(tmpDir, name)).size;
		if (size < minBytes) {
			throw new Error(`Engine file ${name} is ${size} bytes, expected at least ${minBytes}.`);
		}
	}

	mkdirSync(destDir, { recursive: true });
	for (const name of ENGINE_FILES.keys()) {
		renameSync(path.join(tmpDir, name), path.join(destDir, name));
	}

	console.log(
		`[copy-engine-assets] Downloaded, verified and extracted ${written.length} file(s) to static/engine/`
	);
} finally {
	rmSync(tmpDir, { recursive: true, force: true });
}
