import { useState, useRef, useCallback } from 'react';
import { extractAmount, fmtAmount, amountClass, currentMonth } from '../../utils/format';
import type { Transaction } from '../../types';
import MaskedAmount from '../MaskedAmount';

interface Props {
	data: Transaction[] | null;
	isActive: boolean;
	onTxnClick: (txn: Transaction) => void;
}

const START_YEAR = 2026;

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

export default function TransactionsView({ data, isActive, onTxnClick }: Props) {
	const monthKeys = buildMonthKeys();
	const latestMonth = currentMonth();
	const [selectedMonth, setSelectedMonth] = useState(latestMonth);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchResults, setSearchResults] = useState<Transaction[] | null>(null);
	const [isSearching, setIsSearching] = useState(false);
	const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const monthLabel = (key: string) => {
		const dt = new Date(key + '-01T00:00:00');
		return dt.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
	};

	const runSearch = useCallback(async (q: string) => {
		const trimmed = q.trim();
		if (!trimmed) {
			setSearchResults(null);
			return;
		}
		setIsSearching(true);
		try {
			const r = await fetch('/api/search?q=' + encodeURIComponent(trimmed));
			if (!r.ok) throw new Error(String(r.status));
			const json = await r.json() as { raw: string };
			setSearchResults(JSON.parse(json.raw) as Transaction[]);
		} catch {
			setSearchResults([]);
		} finally {
			setIsSearching(false);
		}
	}, []);

	const handleSearchChange = (q: string) => {
		setSearchQuery(q);
		if (searchTimer.current) clearTimeout(searchTimer.current);
		if (!q.trim()) {
			setSearchResults(null);
			return;
		}
		searchTimer.current = setTimeout(() => void runSearch(q), 200);
	};

	const [monthlyTxns, setMonthlyTxns] = useState<Transaction[] | null>(null);
	const [monthLoading, setMonthLoading] = useState(false);

	const handleMonthChange = useCallback(async (month: string) => {
		setSelectedMonth(month);
		if (searchQuery.trim()) return;
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
	}, [searchQuery]);

	const displayTxns = searchQuery.trim()
		? searchResults
		: (monthlyTxns ?? (data ? data.filter(t => (t.tdate || '').startsWith(selectedMonth)) : null));

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
								onClick={() => {
									setSearchQuery('');
									setSearchResults(null);
								}}
							>
								✕
							</button>
						)}
					</div>

					{searchQuery.trim() && searchResults !== null && (
						<div className="search-count">
							{isSearching
								? 'Searching…'
								: searchResults.length === 0
								? 'No results'
								: `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`}
						</div>
					)}

					{!searchQuery.trim() && (
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
