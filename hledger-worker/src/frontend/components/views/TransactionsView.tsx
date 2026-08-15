import { useState, useRef, useCallback, useMemo } from 'react';
import { extractAmount, fmtAmount, amountClass, currentMonth } from '../../utils/format';
import type { Transaction } from '../../types';
import MaskedAmount from '../MaskedAmount';
import { CloseIcon } from '../Icons';

interface Props {
	data: Transaction[] | null;
	accounts: string[];
	isActive: boolean;
	onTxnClick: (txn: Transaction) => void;
}

const START_YEAR = 2026;

interface SearchFilters {
	q: string;
	accounts: string[];
	from: string;
	to: string;
}

function filtersEmpty(f: SearchFilters): boolean {
	return !f.q.trim() && f.accounts.length === 0 && !f.from && !f.to;
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
	const [dateFrom, setDateFrom] = useState('');
	const [dateTo, setDateTo] = useState('');
	const [accountPick, setAccountPick] = useState('');
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [searchResults, setSearchResults] = useState<Transaction[] | null>(null);
	const [isSearching, setIsSearching] = useState(false);
	const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const hasAdvancedFilters = selectedAccounts.length > 0 || dateFrom !== '' || dateTo !== '';
	const hasActiveFilters = searchQuery.trim() !== '' || hasAdvancedFilters;

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
			if (f.from) params.set('from_date', f.from);
			if (f.to) params.set('to_date', f.to);
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

	const currentFilters = (overrides: Partial<SearchFilters> = {}): SearchFilters => ({
		q: searchQuery,
		accounts: selectedAccounts,
		from: dateFrom,
		to: dateTo,
		...overrides,
	});

	const handleSearchChange = (q: string) => {
		setSearchQuery(q);
		triggerSearch(currentFilters({ q }), true);
	};

	const addAccountFilter = (acct: string) => {
		setAccountPick('');
		if (!acct || selectedAccounts.includes(acct)) return;
		const next = [...selectedAccounts, acct];
		setSelectedAccounts(next);
		triggerSearch(currentFilters({ accounts: next }), false);
	};

	const removeAccountFilter = (acct: string) => {
		const next = selectedAccounts.filter(a => a !== acct);
		setSelectedAccounts(next);
		triggerSearch(currentFilters({ accounts: next }), false);
	};

	const handleDateChange = (which: 'from' | 'to', value: string) => {
		const from = which === 'from' ? value : dateFrom;
		const to = which === 'to' ? value : dateTo;
		setDateFrom(from);
		setDateTo(to);
		triggerSearch(currentFilters({ from, to }), true);
	};

	const clearDateFilter = () => {
		setDateFrom('');
		setDateTo('');
		triggerSearch(currentFilters({ from: '', to: '' }), false);
	};

	const clearAllFilters = () => {
		if (searchTimer.current) clearTimeout(searchTimer.current);
		setSearchQuery('');
		setSelectedAccounts([]);
		setDateFrom('');
		setDateTo('');
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

	const dateChipLabel = dateFrom && dateTo
		? `${dateFrom} → ${dateTo}`
		: dateFrom
		? `From ${dateFrom}`
		: dateTo
		? `Until ${dateTo}`
		: null;

	const availableAccounts = accounts.filter(a => !selectedAccounts.includes(a));

	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-transactions">
			{!data ? (
				<div className="state-msg">Tap sync to load data.</div>
			) : (
				<>
					<div className="search-row">
						<div className="search-wrap">
							<input
								type="search"
								className="search-input"
								placeholder="Search transactions…"
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
									aria-label="Clear search"
								>
									<CloseIcon size={14} />
								</button>
							)}
						</div>
						<button
							className={`filter-toggle${advancedOpen ? ' open' : ''}`}
							onClick={() => setAdvancedOpen(o => !o)}
							aria-label="Filters"
							aria-expanded={advancedOpen}
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
							</svg>
							{hasAdvancedFilters && <span className="filter-dot" />}
						</button>
					</div>

					{advancedOpen && (
						<div className="adv-panel">
							<div className="adv-field">
								<span className="adv-label">Date range</span>
								<div className="adv-date-row">
									<label className="adv-date-group">
										<span className="adv-date-caption">From</span>
										<input
											type="date"
											className="adv-date-input"
											value={dateFrom}
											max={dateTo || undefined}
											onChange={e => handleDateChange('from', e.target.value)}
										/>
									</label>
									<label className="adv-date-group">
										<span className="adv-date-caption">To</span>
										<input
											type="date"
											className="adv-date-input"
											value={dateTo}
											min={dateFrom || undefined}
											onChange={e => handleDateChange('to', e.target.value)}
										/>
									</label>
								</div>
							</div>
							<div className="adv-field">
								<span className="adv-label">Category</span>
								<select
									className="adv-select"
									value={accountPick}
									onChange={e => addAccountFilter(e.target.value)}
								>
									<option value="">Add a category…</option>
									{availableAccounts.map(a => (
										<option key={a} value={a}>{a}</option>
									))}
								</select>
							</div>
						</div>
					)}

					{hasAdvancedFilters && (
						<div className="filter-chips">
							{dateChipLabel && (
								<span className="filter-chip">
									{dateChipLabel}
									<button className="filter-chip-remove" onClick={clearDateFilter} aria-label="Remove date filter"><CloseIcon size={11} /></button>
								</span>
							)}
							{selectedAccounts.map(a => (
								<span className="filter-chip" key={a}>
									{a}
									<button className="filter-chip-remove" onClick={() => removeAccountFilter(a)} aria-label={`Remove ${a} filter`}><CloseIcon size={11} /></button>
								</span>
							))}
							<button className="filter-clear-all" onClick={clearAllFilters}>Clear all</button>
						</div>
					)}

					{hasActiveFilters && searchResults !== null && (
						isSearching ? (
							<div className="search-count">Searching…</div>
						) : searchResults.length === 0 ? (
							<div className="search-count">No results</div>
						) : (
							<div className="search-count search-count-row">
								{searchTotal && (
									<MaskedAmount
										value={searchTotal.sum}
										commodity={searchTotal.commodity}
										className={`search-total ${amountClass(searchTotal.sum)}`}
									/>
								)}
								<span>{searchResults.length} result{searchResults.length === 1 ? '' : 's'}</span>
							</div>
						)
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
