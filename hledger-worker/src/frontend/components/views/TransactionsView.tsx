import { useState, useRef, useCallback, useMemo } from 'react';
import { extractAmount, fmtAmount, amountClass, currentMonth } from '../../utils/format';
import type { Transaction } from '../../types';
import MaskedAmount from '../MaskedAmount';

interface Props {
	data: Transaction[] | null;
	accounts: string[];
	isActive: boolean;
	onTxnClick: (txn: Transaction) => void;
}

const START_YEAR = 2026;

type DateFilter =
	| { mode: 'none' }
	| { mode: 'thismonth' }
	| { mode: 'range'; from: string; to: string };

interface SearchFilters {
	q: string;
	accounts: string[];
	dateFilter: DateFilter;
}

function filtersEmpty(f: SearchFilters): boolean {
	return !f.q.trim() && f.accounts.length === 0 && f.dateFilter.mode === 'none';
}

function buildMonthKeys(): string[] {
	const now = new Date();
	const endYear = now.getFullYear();
	const endMonth = now.getMonth() + 1;
	const keys: string[] = [];
	for (let y = endYear; y >= START_YEAR; y--) {
		const mStart = y === endYear ? endMonth : 12;
		const mEnd = y === START_YEAR ? 1 : 1;
		for (let m = mStart; m >= mEnd; m--) {
			keys.push(y + '-' + String(m).padStart(2, '0'));
		}
	}
	return keys;
}

export default function TransactionsView({ data, accounts, isActive, onTxnClick }: Props) {
	const monthKeys = buildMonthKeys();
	const latestMonth = currentMonth();
	const [selectedMonth, setSelectedMonth] = useState(latestMonth);
	const [searchQuery, setSearchQuery] = useState('');
	const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
	const [dateFilter, setDateFilter] = useState<DateFilter>({ mode: 'none' });
	const [accountPick, setAccountPick] = useState('');
	const [searchResults, setSearchResults] = useState<Transaction[] | null>(null);
	const [isSearching, setIsSearching] = useState(false);
	const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const hasActiveFilters = searchQuery.trim() !== '' || selectedAccounts.length > 0 || dateFilter.mode !== 'none';

	const monthLabel = (key: string) => {
		const dt = new Date(key + '-01T00:00:00');
		return dt.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
	};

	const runSearch = useCallback(async (f: SearchFilters) => {
		setIsSearching(true);
		try {
			const params = new URLSearchParams();
			if (f.q.trim()) params.set('q', f.q.trim());
			f.accounts.forEach(a => params.append('account', a));
			if (f.dateFilter.mode === 'thismonth') {
				params.set('period', 'thismonth');
			} else if (f.dateFilter.mode === 'range') {
				if (f.dateFilter.from) params.set('from_date', f.dateFilter.from);
				if (f.dateFilter.to) params.set('to_date', f.dateFilter.to);
			}
			const r = await fetch('/api/search?' + params.toString());
			if (!r.ok) throw new Error(String(r.status));
			const json = await r.json() as { raw: string };
			setSearchResults(JSON.parse(json.raw) as Transaction[]);
		} catch {
			setSearchResults([]);
		} finally {
			setIsSearching(false);
		}
	}, []);

	const triggerSearch = useCallback((f: SearchFilters, debounce: boolean) => {
		if (searchTimer.current) clearTimeout(searchTimer.current);
		if (filtersEmpty(f)) {
			setSearchResults(null);
			return;
		}
		if (debounce) {
			searchTimer.current = setTimeout(() => void runSearch(f), 200);
		} else {
			void runSearch(f);
		}
	}, [runSearch]);

	const handleSearchChange = (q: string) => {
		setSearchQuery(q);
		triggerSearch({ q, accounts: selectedAccounts, dateFilter }, true);
	};

	const addAccountFilter = (acct: string) => {
		setAccountPick('');
		if (!acct || selectedAccounts.includes(acct)) return;
		const next = [...selectedAccounts, acct];
		setSelectedAccounts(next);
		triggerSearch({ q: searchQuery, accounts: next, dateFilter }, false);
	};

	const removeAccountFilter = (acct: string) => {
		const next = selectedAccounts.filter(a => a !== acct);
		setSelectedAccounts(next);
		triggerSearch({ q: searchQuery, accounts: next, dateFilter }, false);
	};

	const toggleThisMonth = () => {
		const next: DateFilter = dateFilter.mode === 'thismonth' ? { mode: 'none' } : { mode: 'thismonth' };
		setDateFilter(next);
		triggerSearch({ q: searchQuery, accounts: selectedAccounts, dateFilter: next }, false);
	};

	const handleDateInputChange = (which: 'from' | 'to', value: string) => {
		const cur = dateFilter.mode === 'range' ? dateFilter : { from: '', to: '' };
		const from = which === 'from' ? value : cur.from;
		const to = which === 'to' ? value : cur.to;
		const next: DateFilter = (!from && !to) ? { mode: 'none' } : { mode: 'range', from, to };
		setDateFilter(next);
		triggerSearch({ q: searchQuery, accounts: selectedAccounts, dateFilter: next }, true);
	};

	const clearDateFilter = () => {
		const next: DateFilter = { mode: 'none' };
		setDateFilter(next);
		triggerSearch({ q: searchQuery, accounts: selectedAccounts, dateFilter: next }, false);
	};

	const clearAllFilters = () => {
		if (searchTimer.current) clearTimeout(searchTimer.current);
		setSearchQuery('');
		setSelectedAccounts([]);
		setDateFilter({ mode: 'none' });
		setSearchResults(null);
	};

	const [monthlyTxns, setMonthlyTxns] = useState<Transaction[] | null>(null);
	const [monthLoading, setMonthLoading] = useState(false);

	const handleMonthChange = useCallback(async (month: string) => {
		setSelectedMonth(month);
		if (hasActiveFilters) return;
		setMonthLoading(true);
		try {
			const r = await fetch(`/api/transactions?month=${month}`);
			if (!r.ok) throw new Error(String(r.status));
			const json = await r.json() as { raw: string };
			setMonthlyTxns(JSON.parse(json.raw) as Transaction[]);
		} catch {
			setMonthlyTxns([]);
		} finally {
			setMonthLoading(false);
		}
	}, [hasActiveFilters]);

	const displayTxns = hasActiveFilters
		? searchResults
		: (monthlyTxns ?? (data ? data.filter(t => (t.tdate || '').startsWith(selectedMonth)) : null));

	const searchTotal = useMemo(() => {
		if (!searchResults || searchResults.length === 0) return null;
		let sum = 0;
		let commodity = '$';
		for (const txn of searchResults) {
			const { val, commodity: com } = extractAmount(txn.tpostings?.[0]?.pamount);
			sum += val;
			commodity = com || commodity;
		}
		return { sum, commodity };
	}, [searchResults]);

	const dateChipLabel = dateFilter.mode === 'thismonth'
		? 'This month'
		: dateFilter.mode === 'range'
		? `${dateFilter.from || 'Start'} → ${dateFilter.to || 'Now'}`
		: null;

	const dateRangeValue = dateFilter.mode === 'range' ? dateFilter : { from: '', to: '' };
	const availableAccounts = accounts.filter(a => !selectedAccounts.includes(a));

	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-transactions">
			{!data ? (
				<div className="state-msg">Tap sync to load data.</div>
			) : (
				<>
					<div className="search-wrap">
						<input
							type="search"
							className="search-input"
							placeholder="Search all transactions…"
							autoComplete="off"
							autoCorrect="off"
							spellCheck={false}
							value={searchQuery}
							onChange={e => handleSearchChange(e.target.value)}
						/>
						{searchQuery && (
							<button
								className="search-clear visible"
								onClick={() => handleSearchChange('')}
							>
								✕
							</button>
						)}
					</div>

					<div className="filter-row">
						<button
							className={`filter-btn${dateFilter.mode === 'thismonth' ? ' active' : ''}`}
							onClick={toggleThisMonth}
						>
							This month
						</button>
						<input
							type="date"
							className="filter-date-input"
							value={dateRangeValue.from}
							onChange={e => handleDateInputChange('from', e.target.value)}
						/>
						<input
							type="date"
							className="filter-date-input"
							value={dateRangeValue.to}
							onChange={e => handleDateInputChange('to', e.target.value)}
						/>
						<select
							className="filter-account-select"
							value={accountPick}
							onChange={e => addAccountFilter(e.target.value)}
						>
							<option value="">+ Category…</option>
							{availableAccounts.map(a => (
								<option key={a} value={a}>{a}</option>
							))}
						</select>
					</div>

					{(selectedAccounts.length > 0 || dateChipLabel) && (
						<div className="filter-chips">
							{dateChipLabel && (
								<span className="filter-chip">
									{dateChipLabel}
									<button className="filter-chip-remove" onClick={clearDateFilter}>✕</button>
								</span>
							)}
							{selectedAccounts.map(a => (
								<span className="filter-chip" key={a}>
									{a}
									<button className="filter-chip-remove" onClick={() => removeAccountFilter(a)}>✕</button>
								</span>
							))}
							<button className="filter-clear-all" onClick={clearAllFilters}>Clear all</button>
						</div>
					)}

					{hasActiveFilters && searchResults !== null && (
						<div className="search-count">
							{isSearching
								? 'Searching…'
								: searchResults.length === 0
								? 'No results'
								: `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`}
							{!isSearching && searchTotal && (
								<>
									{' · Total: '}
									<MaskedAmount
										value={searchTotal.sum}
										commodity={searchTotal.commodity}
										className={amountClass(searchTotal.sum)}
									/>
								</>
							)}
						</div>
					)}

					{!hasActiveFilters && (
						<div className="month-select-row">
							<select
								className="month-select"
								value={selectedMonth}
								onChange={e => void handleMonthChange(e.target.value)}
							>
								{monthKeys.map(k => (
									<option key={k} value={k}>{monthLabel(k)}</option>
								))}
							</select>
						</div>
					)}

					<TxnList
						txns={displayTxns}
						loading={monthLoading || isSearching}
						onTxnClick={onTxnClick}
					/>

					<div className="view-footer">
						Data shown via <code>hledger print -p YYYY-MM</code>. Tap any row to expand.
					</div>
				</>
			)}
		</div>
	);
}

function TxnList({
	txns,
	loading,
	onTxnClick,
}: {
	txns: Transaction[] | null;
	loading: boolean;
	onTxnClick: (t: Transaction) => void;
}) {
	if (loading) return <div className="state-msg">Loading…</div>;
	if (!txns) return null;
	if (txns.length === 0) return <div className="state-msg">No transactions found.</div>;

	return (
		<>
			{txns.map((txn, i) => {
				const desc = txn.tdescription || txn.tpayee || '—';
				const postings = txn.tpostings || [];
				const { val, commodity } = extractAmount(postings[0]?.pamount);
				const accountNames = postings.map(p => p.paccount || '').filter(Boolean).join(' · ');
				const isIncome = postings.some(p => (p.paccount || '').startsWith('income'));
				return (
					<div key={i} className="txn" onClick={() => onTxnClick(txn)}>
						<div className="txn-top">
							<span className="txn-desc">{desc}</span>
							{isIncome ? (
								<MaskedAmount value={val} commodity={commodity} className={`txn-amount ${amountClass(val)}`} />
							) : (
								<span className={`txn-amount ${amountClass(val)}`}>
									{fmtAmount(val, commodity)}
								</span>
							)}
						</div>
						<div className="txn-meta">
							{txn.tdate}
							{accountNames ? ` · ${accountNames}` : ''}
						</div>
					</div>
				);
			})}
		</>
	);
}
