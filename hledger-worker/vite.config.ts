import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import pkg from './package.json' with { type: 'json' };

// The deployed bundle has no git and no package.json to read, so what it can
// report about itself has to be baked in here at build time. Settings shows it
// beside the API's own answer, which is how a half-finished deploy (one side
// updated, the other not) becomes visible from the phone.
function gitShort(): string {
	try {
		return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
	} catch {
		return '';
	}
}

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__APP_COMMIT__: JSON.stringify(gitShort()),
	},
	plugins: [
		react(),
		cloudflare(),
	],
});
