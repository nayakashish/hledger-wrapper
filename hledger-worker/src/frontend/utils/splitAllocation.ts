/**
 * Convert percentage splits into exact cent-accurate dollar amounts that sum
 * to totalAmount, using the largest-remainder method (a.k.a. Hamilton's
 * apportionment method) — the standard way accounting/payroll systems turn
 * percentages into cents without rounding drift: round each share down to
 * the cent, then hand out the leftover pennies (or claw back excess ones)
 * to whichever entries were closest to rounding the other way. The result is
 * deterministic — identical inputs always produce identical output cents,
 * so there's no accumulated drift from repeated splits.
 */
export function allocateByPercent(
	totalAmount: number,
	percents: Record<string, number>
): Record<string, number> {
	const ids = Object.keys(percents);
	if (ids.length === 0) return {};

	const totalCents = Math.round(totalAmount * 100);
	const raw = ids.map(id => (totalCents * (percents[id] || 0)) / 100);
	const floors = raw.map(Math.floor);
	const remainders = raw.map((r, i) => r - floors[i]);
	const cents = [...floors];

	const leftover = totalCents - floors.reduce((a, b) => a + b, 0);

	if (leftover > 0) {
		// Hand out leftover cents to the rows most under-rounded first.
		const order = ids.map((_, i) => i).sort((a, b) => remainders[b] - remainders[a] || a - b);
		for (let k = 0; k < leftover; k++) cents[order[k % order.length]] += 1;
	} else if (leftover < 0) {
		// Percentages summed over 100% — claw back cents from the rows
		// least affected by rounding down first. Cycles through `order`
		// (like the leftover > 0 branch) rather than a single pass, since
		// the overage can exceed the number of rows.
		const order = ids.map((_, i) => i).sort((a, b) => remainders[a] - remainders[b] || a - b);
		let toRemove = -leftover;
		const maxIterations = order.length * (toRemove + 1);
		for (let k = 0; toRemove > 0 && k < maxIterations; k++) {
			const idx = order[k % order.length];
			if (cents[idx] > 0) {
				cents[idx] -= 1;
				toRemove--;
			}
		}
	}

	const result: Record<string, number> = {};
	ids.forEach((id, i) => { result[id] = cents[i] / 100; });
	return result;
}

/** Inverse of allocateByPercent, for seeding percent-mode inputs from an
 * existing dollar amount when switching modes. Not used for the final
 * dollar amounts submitted to the API — those always go through
 * allocateByPercent. */
export function percentOfTotal(amount: number, total: number): number {
	if (!total) return 0;
	return Math.round((amount / total) * 100 * 100) / 100;
}
