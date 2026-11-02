// Whether the API server is reachable, as seen from the phone.
//
// Detection is passive: every /api/* response the app already makes says
// whether the server answered, so a failure shows up on the next request
// without extra polling. The app's calls go through ~16 fetch sites, so one
// wrapper around fetch covers them all instead of a change at each.

// The Worker returns 502 (unreachable) or 504 (timed out); Cloudflare returns
// 52x/530 when the tunnel or origin is down. A plain 500 is the server
// answering with an error, so it doesn't count.
const DOWN_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);

const PROBE_TIMEOUT_MS = 8000;

type Listener = (down: boolean) => void;

let serverDown = false;
const listeners = new Set<Listener>();

function report(down: boolean) {
	if (down === serverDown) return;
	serverDown = down;
	listeners.forEach(l => l(down));
}

export function isServerDown(): boolean {
	return serverDown;
}

export function subscribeServerHealth(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function isApiRequest(input: RequestInfo | URL): boolean {
	const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const url = new URL(raw, window.location.origin);
	return url.origin === window.location.origin && url.pathname.startsWith('/api/');
}

// Wraps window.fetch once, at startup, to watch /api/* responses.
export function installServerHealthTracking() {
	const original = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		if (!isApiRequest(input)) return original(input, init);
		try {
			const r = await original(input, init);
			report(DOWN_STATUSES.has(r.status));
			return r;
		} catch (e) {
			// With no network the phone can't say anything about the server.
			if (navigator.onLine && !(e instanceof DOMException && e.name === 'AbortError')) report(true);
			throw e;
		}
	};
}

// One explicit check, used to notice the server coming back.
export async function probeServer(): Promise<void> {
	if (!navigator.onLine) return;
	try {
		await fetch('/api/health', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' });
	} catch {
		// the wrapper has already recorded the result
	}
}
