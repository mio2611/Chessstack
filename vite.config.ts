// adapter-node compiles SvelteKit into a plain Node.js HTTP server.
// This is the correct adapter for a self-hosted Docker deployment.
// The built output lands in /build and is started with: node build/index.js
import adapter from '@sveltejs/adapter-node';

import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit({ adapter: adapter() })],
	build: { minify: false }
});
