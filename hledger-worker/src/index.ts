/**
 * hledger Worker
 *
 * Responsibilities:
 * 1. Handle /api/demo/* — serve mock data from KV (demo mode, no auth needed)
 * 2. Handle /api/* — proxy to home FastAPI server via Cloudflare Tunnel,
 *    injecting auth secrets server-side so they never reach the browser
 * 3. Fall through to Workers Assets for the React SPA
 *
 * Secrets (set via `wrangler secret put <name>`):
 *   API_BASE_URL            - e.g. https://hledger-api.nayakashish.cc
 *   BEARER_TOKEN            - the token your FastAPI validates
 *   CF_ACCESS_CLIENT_ID     - Cloudflare Access service token ID
 *   CF_ACCESS_CLIENT_SECRET - Cloudflare Access service token secret
 *
 * KV namespace (set in wrangler.jsonc):
 *   DEMO_DATA               - KV namespace binding for mock data
 *
 * Assets binding (set in wrangler.jsonc):
 *   ASSETS                  - Workers Assets binding (serves built React app)
 *
 * Demo PIN: hardcoded below. Anyone with repo access can see it —
 * that's acceptable. It never appears in the browser bundle.
 */

const DEMO_PIN = '1919';

export interface Env {
	API_BASE_URL: string;
	BEARER_TOKEN: string;
	CF_ACCESS_CLIENT_ID: string;
	CF_ACCESS_CLIENT_SECRET: string;
	DEMO_DATA: KVNamespace;
	ASSETS: Fetcher;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Demo data routes — served from KV, no auth required
		if (url.pathname.startsWith('/api/demo/')) {
			return serveDemoData(request, url, env);
		}

		// API proxy routes — forward to FastAPI with injected auth
		if (url.pathname.startsWith('/api/')) {
			return proxyToApi(request, url, env);
		}

		// Everything else served by Workers Assets (the React SPA)
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Demo data handler — reads from KV namespace DEMO_DATA
// ---------------------------------------------------------------------------

async function serveDemoData(request: Request, url: URL, env: Env): Promise<Response> {
	const segment = url.pathname.replace(/^\/api\/demo\/?/, '').split('/')[0];

	// POST /api/demo/verify-pin  { pin: "1234" }  →  { ok: true/false }
	// The real PIN lives only in this Worker — never reaches the browser bundle.
	if (segment === 'verify-pin') {
		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 });
		}
		let body: { pin?: string } = {};
		try { body = await request.json(); } catch (_) { /* ignore parse error */ }
		const ok = typeof body.pin === 'string' && body.pin === DEMO_PIN;
		return jsonResponse({ ok });
	}

	// No-op sync in demo mode
	if (segment === 'sync') {
		return jsonResponse({ status: 'ok', detail: 'demo mode — no sync performed' });
	}

	// Accounts and descriptions from KV
	if (segment === 'accounts') {
		const raw = await env.DEMO_DATA.get('accounts');
		if (!raw) return jsonResponse({ accounts: [] });
		return jsonResponse(JSON.parse(raw));
	}

	if (segment === 'descriptions') {
		const raw = await env.DEMO_DATA.get('descriptions');
		if (!raw) return jsonResponse({ descriptions: [] });
		return jsonResponse(JSON.parse(raw));
	}

	// Main data endpoints — all return { raw: string }
	const validKeys = ['balance', 'is', 'monthly', 'transactions'];
	if (!validKeys.includes(segment)) {
		return new Response(JSON.stringify({ error: 'unknown demo endpoint' }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const value = await env.DEMO_DATA.get(segment);
	if (!value) {
		return new Response(JSON.stringify({ error: 'demo data not loaded for: ' + segment }), {
			status: 503,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	return jsonResponse({ raw: value });
}

function jsonResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

// ---------------------------------------------------------------------------
// Proxy handler — forwards to FastAPI with auth headers injected
// ---------------------------------------------------------------------------

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
		return new Response(JSON.stringify({ error: 'Failed to reach API' }), {
			status: 502,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}
