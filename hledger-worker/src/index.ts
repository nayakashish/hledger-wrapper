/**
 * hledger Worker
 *
 * Responsibilities:
 * 1. Handle /api/* — proxy to home FastAPI server via Cloudflare Tunnel,
 *    injecting auth secrets server-side so they never reach the browser
 * 2. Handle inbound email (Cloudflare Email Routing) — parse bank alert
 *    emails and push them to the FastAPI transaction inbox
 * 3. Fall through to Workers Assets for the React SPA
 *
 * Secrets (set via `wrangler secret put <name>`):
 *   API_BASE_URL            - e.g. https://hledger-api.nayakashish.cc
 *   BEARER_TOKEN            - the token your FastAPI validates
 *   CF_ACCESS_CLIENT_ID     - Cloudflare Access service token ID
 *   CF_ACCESS_CLIENT_SECRET - Cloudflare Access service token secret
 *
 * Vars (wrangler.jsonc):
 *   FORWARD_VERIFICATION_EMAIL - where Gmail's forwarding-confirmation
 *                                emails get forwarded so the auto-forward
 *                                address can be verified
 *
 * Assets binding (set in wrangler.jsonc):
 *   ASSETS                  - Workers Assets binding (serves built React app)
 */

import PostalMime from 'postal-mime';

export interface Env {
	API_BASE_URL: string;
	BEARER_TOKEN: string;
	CF_ACCESS_CLIENT_ID: string;
	CF_ACCESS_CLIENT_SECRET: string;
	FORWARD_VERIFICATION_EMAIL: string;
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

	async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
		return handleEmail(message, env);
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

function apiAuthHeaders(env: Env): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
		'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
		'Authorization': `Bearer ${env.BEARER_TOKEN}`,
	};
}

async function proxyToApi(request: Request, url: URL, env: Env): Promise<Response> {
	const apiPath = url.pathname.replace(/^\/api/, '');
	const targetUrl = `${env.API_BASE_URL}${apiPath}${url.search}`;

	const proxyRequest = new Request(targetUrl, {
		method: request.method,
		headers: apiAuthHeaders(env),
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

// ---------------------------------------------------------------------------
// Email handler — bank alerts arrive via Gmail auto-forward to the
// Email Routing address, get parsed, and land in the FastAPI inbox.
//
// Gmail is the origin of the forward, so alerts are NOT forwarded back to
// Gmail (that would re-trigger the forwarding filter and loop). The only
// thing forwarded is Gmail's own forwarding-confirmation email, needed
// once to verify the auto-forward destination.
// ---------------------------------------------------------------------------

interface ParsedAlert {
	amount: number;
	merchant: string;
	card_last4: string;
	bank: string;
}

interface BankParser {
	bank: string;
	fromMatch: RegExp; // tested against the original From header address
	parse: (subject: string, body: string) => ParsedAlert | null;
}

const BANK_PARSERS: BankParser[] = [
	{
		bank: 'cibc',
		fromMatch: /@(?:[a-z0-9-]+\.)*cibc\.(?:com|ca)$/i,
		// "You've recently made a purchase with your CIBC Costco Mastercard
		//  ending in 1234 for $22.94 at TST-The Samosa Factory."
		parse: (_subject, body) => {
			const flat = body.replace(/\s+/g, ' ');
			const m = flat.match(/ending in (\d{4}) for \$([\d,]+\.\d{2}) at (.+?)\.(?:\s|$)/);
			if (!m) return null;
			return {
				amount: parseFloat(m[2].replace(/,/g, '')),
				merchant: m[3].trim(),
				card_last4: m[1],
				bank: 'cibc',
			};
		},
	},
];

// Gmail sends the auto-forward confirmation from forwarding-noreply@google.com
const VERIFICATION_FROM = /@google\.com$/i;

const ALERT_TIMEZONE = 'America/Toronto';

function alertDate(emailDate: string | undefined): string {
	const parsed = emailDate ? new Date(emailDate) : new Date();
	const d = isNaN(parsed.getTime()) ? new Date() : parsed;
	// en-CA formats as YYYY-MM-DD
	return new Intl.DateTimeFormat('en-CA', { timeZone: ALERT_TIMEZONE }).format(d);
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ');
}

// A manually forwarded alert has the owner as the From header and the
// original sender inside the "Forwarded message" block. Returns the embedded
// From address and Date line, or null if the body is not a forward.
function unwrapForwarded(body: string): { fromAddr: string; date?: string } | null {
	const block = body.match(/Forwarded message[\s\S]{0,500}/i);
	if (!block) return null;
	const fromLine = block[0].match(/From:([^\n]*)/i);
	if (!fromLine) return null;
	const bracketed = fromLine[1].match(/<\s*([\w.+-]+@[\w.-]+)\s*>/);
	const bare = fromLine[1].match(/[\w.+-]+@[\w.-]+/);
	const fromAddr = bracketed ? bracketed[1] : bare ? bare[0] : null;
	if (!fromAddr) return null;
	const date = block[0].match(/Date:\s*([^\n]+)/i);
	return {
		fromAddr,
		// Gmail writes "Wed, Jun 4, 2025 at 3:02 PM" — Date() chokes on "at"
		date: date ? date[1].replace(/\bat\b/i, '').trim() : undefined,
	};
}

async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
	const email = await PostalMime.parse(message.raw);
	// Gmail filter auto-forwarding rewrites the envelope sender but preserves
	// the original From header, so the bank is identified from the parsed header.
	const fromAddr = email.from?.address ?? message.from;

	if (VERIFICATION_FROM.test(fromAddr)) {
		await message.forward(env.FORWARD_VERIFICATION_EMAIL);
		return;
	}

	const subject = email.subject ?? '';
	const body = email.text ?? stripHtml(email.html ?? '');
	let dateHeader = email.date;

	let parser = BANK_PARSERS.find(p => p.fromMatch.test(fromAddr));

	// Manually forwarded alert from the owner (testing / backfilling old
	// alerts): trust the From line embedded in the forwarded block instead.
	if (!parser && fromAddr.toLowerCase() === env.FORWARD_VERIFICATION_EMAIL.toLowerCase()) {
		const inner = unwrapForwarded(body);
		if (inner) {
			parser = BANK_PARSERS.find(p => p.fromMatch.test(inner.fromAddr));
			if (inner.date && !isNaN(new Date(inner.date).getTime())) {
				dateHeader = inner.date;
			}
		}
	}

	if (!parser) {
		// Unknown sender — the address will leak eventually; drop silently
		return;
	}

	const alert = parser.parse(subject, body);

	const payload = {
		amount: alert?.amount ?? 0,
		merchant: alert?.merchant ?? (subject || `Unparsed ${parser.bank} alert`),
		card_last4: alert?.card_last4 ?? '',
		bank: parser.bank,
		txn_date: alertDate(dateHeader),
		email_message_id: email.messageId ?? '',
		raw_subject: subject,
		parsed: alert !== null,
	};

	const r = await fetch(`${env.API_BASE_URL}/inbox/ingest`, {
		method: 'POST',
		headers: apiAuthHeaders(env),
		body: JSON.stringify(payload),
	});
	if (!r.ok) {
		// Surface the failure in the Email Routing dashboard; the original
		// alert is still in Gmail, and dedup makes retries safe.
		throw new Error(`inbox ingest failed: ${r.status}`);
	}
}
