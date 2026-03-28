/**
 * hledger Worker
 *
 * Responsibilities:
 * 1. Proxy /api/* requests to the home Linux machine via Cloudflare Tunnel,
 *    injecting auth secrets server-side so they never reach the browser.
 * 2. Serve demo data from KV when requests come in on /api/demo/*
 * 3. Serve the frontend SPA on GET /
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
 * Demo PIN: hardcoded below. Anyone with repo access can see it — that's
 * acceptable. The important thing is it never appears in the browser bundle.
 */

const DEMO_PIN = '1919';

export interface Env {
	API_BASE_URL: string;
	BEARER_TOKEN: string;
	CF_ACCESS_CLIENT_ID: string;
	CF_ACCESS_CLIENT_SECRET: string;
	DEMO_DATA: KVNamespace;
}

// @ts-ignore
import HTML from '../public/index.html';
// @ts-ignore
import MANIFEST from '../public/manifest.json';
// @ts-ignore
import SW from '../public/sw.js';
// @ts-ignore
import ICON192 from '../public/icon-192.png';
// @ts-ignore
import ICON512 from '../public/icon-512.png';
// @ts-ignore
import APPLETOUCHICON from '../public/apple-touch-icon.png';
// @ts-ignore
import FAVICON32 from '../public/favicon-32.png';
// @ts-ignore
import FAVICON16 from '../public/favicon-16.png';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// ------------------------------------------------------------------
		// Route: /api/demo/*  →  serve mock data from KV or handle pin
		// ------------------------------------------------------------------
		if (url.pathname.startsWith("/api/demo/")) {
			return serveDemoData(request, url, env);
		}

		// ------------------------------------------------------------------
		// Route: /api/*  →  proxy to FastAPI
		// ------------------------------------------------------------------
		if (url.pathname.startsWith("/api/")) {
			return proxyToApi(request, url, env);
		}

		// ------------------------------------------------------------------
		// Route: GET /  →  serve SPA
		// ------------------------------------------------------------------
		if (url.pathname === "/" && request.method === "GET") {
			return new Response(HTML, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}

		// ------------------------------------------------------------------
		// PWA assets
		// ------------------------------------------------------------------
		if (url.pathname === "/manifest.json") {
			return new Response(MANIFEST, {
				headers: { "Content-Type": "application/manifest+json" },
			});
		}

		if (url.pathname === "/sw.js") {
			return new Response(SW, {
				headers: {
					"Content-Type": "application/javascript",
					"Service-Worker-Allowed": "/",
				},
			});
		}

		// Icons
		const icons: Record<string, { data: ArrayBuffer }> = {
			"/icon-192.png": ICON192,
			"/icon-512.png": ICON512,
			"/apple-touch-icon.png": APPLETOUCHICON,
			"/favicon-32.png": FAVICON32,
			"/favicon-16.png": FAVICON16,
		};
		if (url.pathname in icons) {
			return new Response(icons[url.pathname] as unknown as ArrayBuffer, {
				headers: { "Content-Type": "image/png" },
			});
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Demo data handler — reads from KV namespace DEMO_DATA
// ---------------------------------------------------------------------------

async function serveDemoData(request: Request, url: URL, env: Env): Promise<Response> {
	const segment = url.pathname.replace(/^\/api\/demo\/?/, '').split('/')[0];

	// ── PIN verification ────────────────────────────────────────────────────
	// POST /api/demo/verify-pin  { pin: "1234" }  →  { ok: true/false }
	// The real PIN lives only in this file — never reaches the browser bundle.
	if (segment === 'verify-pin') {
		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 });
		}
		let body: { pin?: string } = {};
		try { body = await request.json(); } catch (_) {}
		const ok = typeof body.pin === 'string' && body.pin === DEMO_PIN;
		return jsonResponse({ ok });
	}

	// ── No-op sync ──────────────────────────────────────────────────────────
	if (segment === 'sync') {
		return jsonResponse({ status: 'ok', detail: 'demo mode — no sync performed' });
	}

	// ── Accounts / descriptions ─────────────────────────────────────────────
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

	// ── Main data endpoints — all return { raw: string } ───────────────────
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
// Proxy handler
// ---------------------------------------------------------------------------

async function proxyToApi(request: Request, url: URL, env: Env): Promise<Response> {
	const apiPath = url.pathname.replace(/^\/api/, "");
	const targetUrl = `${env.API_BASE_URL}${apiPath}${url.search}`;

	const proxyRequest = new Request(targetUrl, {
		method: request.method,
		headers: {
			"Content-Type": "application/json",
			"CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
			"CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
			"Authorization": `Bearer ${env.BEARER_TOKEN}`,
		},
		body: request.method !== "GET" && request.method !== "HEAD"
			? await request.text()
			: undefined,
	});

	try {
		const response = await fetch(proxyRequest);
		return new Response(response.body, {
			status: response.status,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
			},
		});
	} catch (err) {
		return new Response(JSON.stringify({ error: "Failed to reach API" }), {
			status: 502,
			headers: { "Content-Type": "application/json" },
		});
	}
}