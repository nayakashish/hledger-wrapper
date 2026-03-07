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