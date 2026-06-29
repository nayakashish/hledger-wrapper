import { useState, useMemo, useEffect } from 'react';
import { extractAmount, fmtAmount, amountClass } from '../../utils/format';
import { usePrivacy } from '../../context/PrivacyContext';
import type { MonthlyData, Amount, Transaction } from '../../types';

interface Props {
	data: MonthlyData | null;
	isActive: boolean;
	onTxnClick: (txn: Transaction) => void;
}

export default function MonthlyView({ data, isActive, onTxnClick }: Props) {
	const periodLabels = useMemo(() => {
		if (!data) return [];
		return (data.prDates || []).map(d => {
			const start = d[0]?.contents ?? '';
			if (!start) return '—';
			const dt = new Date(start + 'T00:00:00');
			return dt.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
		});
	}, [data]);

	const lastIdx = periodLabels.length - 1;
	const [periodIdx, setPeriodIdx] = useState(lastIdx < 0 ? 0 : lastIdx);

	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-monthly">
			{!data ? (
				<div className="state-msg">Tap sync to load data.</div>
			) : (
				<>
					<div className="month-select-row">
						<select
							className="month-select"
							value={periodIdx}
							onChange={e => setPeriodIdx(parseInt(e.target.value))}
						>
							{[...periodLabels].reverse().map((label, revIdx) => {
								const idx = periodLabels.length - 1 - revIdx;
								return (
									<option key={idx} value={idx}>{label}</option>
								);
							})}
						</select>
					</div>
					<MonthlyTable
						data={data}
						periodIdx={periodIdx}
						onTxnClick={onTxnClick}
					/>
					<div className="view-footer">
						Data shown via <code>hledger balance --monthly</code>. Tap a row to see transactions.
					</div>
				</>
			)}
		</div>
	);
}

function MonthlyTable({
	data,
	periodIdx,
	onTxnClick,
}: {
	data: MonthlyData;
	periodIdx: number;
	onTxnClick: (txn: Transaction) => void;
}) {
	const { privacyMode } = usePrivacy();
	const [expanded, setExpanded] = useState<string | null>(null);
	const [txnsByMonth, setTxnsByMonth] = useState<Record<string, Transaction[]>>({});
	const [loading, setLoading] = useState(false);

	// Collapse expansion when period changes
	useEffect(() => { setExpanded(null); }, [periodIdx]);

	const monthKey = data.prDates[periodIdx]?.[0]?.contents?.slice(0, 7) ?? '';

	const handleRowClick = async (fullName: string) => {
		if (expanded === fullName) {
			setExpanded(null);
			return;
		}
		setExpanded(fullName);
		if (monthKey && !txnsByMonth[monthKey]) {
			setLoading(true);
			try {
				const r = await fetch(`/api/transactions?month=${monthKey}`);
				if (!r.ok) throw new Error(String(r.status));
				const json = await r.json() as { raw: string };
				const txns = JSON.parse(json.raw) as Transaction[];
				setTxnsByMonth(prev => ({ ...prev, [monthKey]: txns }));
			} catch {
				setTxnsByMonth(prev => ({ ...prev, [monthKey]: [] }));
			} finally {
				setLoading(false);
			}
		}
	};

	const amountMap: Record<string, Amount[]> = {};
	data.prRows.forEach(row => {
		const amts = row.prrAmounts?.[periodIdx] ?? [];
		if (amts.length > 0) {
			const { val } = extractAmount(amts);
			if (val !== 0) amountMap[row.prrName] = amts;
		}
	});

	if (Object.keys(amountMap).length === 0) {
		return <div className="state-msg">No activity this month.</div>;
	}

	const allNames = new Set<string>();
	Object.keys(amountMap).forEach(name => {
		const parts = name.split(':');
		for (let i = 1; i <= parts.length; i++) allNames.add(parts.slice(0, i).join(':'));
	});

	const sorted = Array.from(allNames).sort();
	const groups: Record<string, string[]> = {};
	const groupOrder: string[] = [];
	sorted.forEach(name => {
		const top = name.split(':')[0];
		if (!groups[top]) { groups[top] = []; groupOrder.push(top); }
		if (name !== top) groups[top].push(name);
	});

	const monthTxns = txnsByMonth[monthKey] ?? [];

	return (
		<>
			{groupOrder.map(group => (
				<div key={group}>
					<div className="section-title">{group}</div>
					{groups[group].map(fullName => {
						const depth = (fullName.match(/:/g) || []).length;
						const amounts = amountMap[fullName] || [];
						const { val, commodity } = extractAmount(amounts);
						const label = fullName.split(':').pop() || fullName;
						const indentPx = (depth - 1) * 16;
						const hasChildren = sorted.some(n => n !== fullName && n.startsWith(fullName + ':'));
						const isExpanded = expanded === fullName;
						const rowTxns = monthTxns.filter(txn =>
							(txn.tpostings || []).some(p => (p.paccount || '').startsWith(fullName))
						);
						return (
							<div key={fullName}>
								<div
									className={`account-row drilldown-row${isExpanded ? ' expanded' : ''}`}
									onClick={() => void handleRowClick(fullName)}
								>
									<span
										className="account-name"
										style={{
											paddingLeft: indentPx,
											...(hasChildren ? { fontWeight: 500, color: 'var(--accent)' } : {}),
										}}
									>
										{label}
									</span>
									<span className={`account-amount ${amountClass(val)}`}>
										{amounts.length > 0
											? (privacyMode && fullName.startsWith('income') ? '••••' : fmtAmount(val, commodity))
											: ''}
									</span>
								</div>
								{isExpanded && (
									<div className="drilldown-txns">
										{loading && !txnsByMonth[monthKey] ? (
											<div className="drilldown-loading">Loading…</div>
										) : rowTxns.length === 0 ? (
											<div className="drilldown-loading">No transactions found.</div>
										) : (
											rowTxns.map((txn, i) => {
												const desc = txn.tdescription || txn.tpayee || '—';
												const postings = txn.tpostings || [];
												const { val: tval, commodity: tcom } = extractAmount(postings[0]?.pamount);
												return (
													<div key={i} className="drilldown-txn" onClick={e => { e.stopPropagation(); onTxnClick(txn); }}>
														<div className="txn-top">
															<span className="txn-desc">{desc}</span>
															<span className={`txn-amount ${amountClass(tval)}`}>
																{fmtAmount(tval, tcom)}
															</span>
														</div>
														<div className="txn-meta">{txn.tdate}</div>
													</div>
												);
											})
										)}
									</div>
								)}
							</div>
						);
					})}
					<br />
				</div>
			))}
		</>
	);
}
