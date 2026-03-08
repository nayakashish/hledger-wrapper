/**
 * hledger Worker
 *
 * Responsibilities:
 * 1. Proxy /api/* requests to the home Linux machine via Cloudflare Tunnel,
 *    injecting auth secrets server-side so they never reach the browser.
 * 2. Serve the frontend SPA on GET /
 *
 * Secrets (set via `wrangler secret put <name>`):
 *   API_BASE_URL            - e.g. https://hledger-api.nayakashish.cc
 *   BEARER_TOKEN            - the token your FastAPI validates
 *   CF_ACCESS_CLIENT_ID     - Cloudflare Access service token ID
 *   CF_ACCESS_CLIENT_SECRET - Cloudflare Access service token secret
 */

export interface Env {
	API_BASE_URL: string;
	BEARER_TOKEN: string;
	CF_ACCESS_CLIENT_ID: string;
	CF_ACCESS_CLIENT_SECRET: string;
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