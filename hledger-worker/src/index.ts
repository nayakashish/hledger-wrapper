/**
 * hledger Worker
 *
 * Responsibilities:
 * 1. Handle /api/* — proxy to home FastAPI server via Cloudflare Tunnel,
 *    injecting auth secrets server-side so they never reach the browser
 * 2. Fall through to Workers Assets for the React SPA
 *
 * Secrets (set via `wrangler secret put <name>`):
 *   API_BASE_URL            - e.g. https://hledger-api.nayakashish.cc
 *   BEARER_TOKEN            - the token your FastAPI validates
 *   CF_ACCESS_CLIENT_ID     - Cloudflare Access service token ID
 *   CF_ACCESS_CLIENT_SECRET - Cloudflare Access service token secret
 *
 * Assets binding (set in wrangler.jsonc):
 *   ASSETS                  - Workers Assets binding (serves built React app)
 */

export interface Env {
	API_BASE_URL: string;
	BEARER_TOKEN: string;
	CF_ACCESS_CLIENT_ID: string;
	CF_ACCESS_CLIENT_SECRET: string;
	ASSETS: Fetcher;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// API proxy routes — forward to FastAPI with injected auth
		if (url.pathname.startsWith('/api/')) {
			return proxyToApi(request, url, env);
		}

		// Everything else served by Workers Assets (the React SPA)
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Proxy handler — forwards to FastAPI with auth headers injected
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

async function proxyToApi(request: Request, url: URL, env: Env): Promise<Response> {
	const apiPath = url.pathname.replace(/^\/api/, '');
	const targetUrl = `${env.API_BASE_URL}${apiPath}${url.search}`;

	const proxyRequest = new Request(targetUrl, {
		method: request.method,
		headers: {
			'Content-Type': 'application/json',
			'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
			'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
			'Authorization': `Bearer ${env.BEARER_TOKEN}`,
		},
		body: request.method !== 'GET' && request.method !== 'HEAD'
			? await request.text()
			: undefined,
	});

	try {
		const response = await fetch(proxyRequest);
		return new Response(response.body, {
			status: response.status,
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
			},
		});
	} catch (_) {
		return jsonResponse({ error: 'Failed to reach API' });
	}
}
