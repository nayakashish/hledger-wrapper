import type { Amount } from '../types';

export function extractAmount(amounts?: Amount[]): { val: number; commodity: string } {
	if (!amounts || amounts.length === 0) return { val: 0, commodity: '$' };
	const a = amounts[0];
	const val =
		typeof a.aquantity === 'object'
			? parseFloat(String(a.aquantity.decimalMantissa)) /
			  Math.pow(10, a.aquantity.decimalPlaces || 0)
			: parseFloat(String(a.aquantity)) || 0;
	return { val, commodity: a.acommodity || '$' };
}

export function fmtAmount(num: number, commodity = '$'): string {
	const abs = Math.abs(num).toFixed(2);
	const formatted =
		commodity + parseFloat(abs).toLocaleString('en-CA', { minimumFractionDigits: 2 });
	return num < 0 ? `-${formatted}` : formatted;
}

export function amountClass(num: number): string {
	if (num > 0) return 'amount-positive';
	if (num < 0) return 'amount-negative';
	return 'amount-neutral';
}

export function currentMonth(): string {
	const now = new Date();
	return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

export function formatSyncTime(isoString: string): string {
	const dt = new Date(isoString);
	const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
	const date = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
	const isToday = dt.toDateString() === new Date().toDateString();
	return 'last synced ' + (isToday ? time : date + ' ' + time);
}
