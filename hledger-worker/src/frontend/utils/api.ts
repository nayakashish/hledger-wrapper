const API = '';

export async function apiGet<T>(path: string): Promise<T> {
	const r = await fetch(`${API}${path}`);
	if (!r.ok) {
		let detail = '';
		try {
			const j = await r.json() as { detail?: string };
			detail = j.detail || '';
		} catch (_) { /* ignore */ }
		throw new Error(detail || `status ${r.status}`);
	}
	return r.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
	const r = await fetch(`${API}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!r.ok) {
		let detail = '';
		try {
			const j = await r.json() as { detail?: string };
			detail = j.detail || '';
		} catch (_) { /* ignore */ }
		throw new Error(detail || `status ${r.status}`);
	}
	return r.json() as Promise<T>;
}

export async function apiDelete<T>(path: string): Promise<T> {
	const r = await fetch(`${API}${path}`, { method: 'DELETE' });
	if (!r.ok) {
		let detail = '';
		try {
			const j = await r.json() as { detail?: string };
			detail = j.detail || '';
		} catch (_) { /* ignore */ }
		throw new Error(detail || `status ${r.status}`);
	}
	return r.json() as Promise<T>;
}

export async function loadRawEndpoint<T>(
	name: string,
	params?: Record<string, string>
): Promise<T> {
	const qs = params ? '?' + new URLSearchParams(params).toString() : '';
	const r = await fetch(`${API}/api/${name}${qs}`);
	if (!r.ok) throw new Error(`${r.status}`);
	const json = await r.json() as { raw: string };
	return JSON.parse(json.raw) as T;
}
