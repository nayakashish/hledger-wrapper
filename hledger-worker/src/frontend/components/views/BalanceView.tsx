import { useState, useEffect } from 'react';
import { extractAmount, fmtAmount, amountClass } from '../../utils/format';
import { currentMonth } from '../../utils/format';
import type { BalanceRow, Transaction } from '../../types';

interface Props {
	data: BalanceRow[][] | null;
	isActive: boolean;
}

export default function BalanceView({ data, isActive }: Props) {
	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-balance">
			{!data ? (
				<div className="state-msg">Tap sync to load data.</div>
			) : (
				<BalanceContent data={data} />
			)}
		</div>
	);
}

function BalanceContent({ data }: { data: BalanceRow[][] }) {
	const rows = Array.isArray(data[0]) ? data[0] : [];
	if (rows.length === 0) return <div className="state-msg">No data.</div>;

	const [expanded, setExpanded] = useState<string | null>(null);
	const [txnsByMonth, setTxnsByMonth] = useState<Record<string, Transaction[]>>({});
	const [loading, setLoading] = useState(false);

	const month = currentMonth();

	// Reset expansion when data changes (e.g. after sync)
	useEffect(() => { setExpanded(null); }, [data]);

	const handleRowClick = async (fullName: string) => {
		if (expanded === fullName) {
			setExpanded(null);
			return;
		}
		setExpanded(fullName);
		if (!txnsByMonth[month]) {
			setLoading(true);
			try {
				const r = await fetch(`/api/transactions?month=${month}`);
				if (!r.ok) throw new Error(String(r.status));
				const json = await r.json() as { raw: string };
				setTxnsByMonth(prev => ({ ...prev, [month]: JSON.parse(json.raw) as Transaction[] }));
			} catch {
				setTxnsByMonth(prev => ({ ...prev, [month]: [] }));
			} finally {
				setLoading(false);
			}
		}
	};

	const amountMap: Record<string, BalanceRow[3]> = {};
	rows.forEach(row => { amountMap[row[0]] = row[3]; });

	const allNames = new Set<string>();
	rows.forEach(row => {
		const parts = (row[0] as string).split(':');
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

	const monthTxns = txnsByMonth[month] ?? [];

	return (
		<>
			{groupOrder.map(group => (
				<div key={group}>
					<div className="section-title">{group}</div>
					{groups[group].map(fullName => {
						const depth = (fullName.match(/:/g) || []).length;
						const amounts = amountMap[fullName] || [];
						const { val, commodity } = extractAmount(amounts as Parameters<typeof extractAmount>[0]);
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
										{amounts.length > 0 ? fmtAmount(val, commodity) : ''}
									</span>
								</div>
								{isExpanded && (
									<div className="drilldown-txns">
										{loading && !txnsByMonth[month] ? (
											<div className="drilldown-loading">Loading…</div>
										) : rowTxns.length === 0 ? (
											<div className="drilldown-loading">No transactions this month.</div>
										) : (
											rowTxns.map((txn, i) => {
												const desc = txn.tdescription || txn.tpayee || '—';
												const postings = txn.tpostings || [];
												const { val: tval, commodity: tcom } = extractAmount(postings[0]?.pamount);
												return (
													<div key={i} className="drilldown-txn">
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
			<div className="view-footer">
				Data shown via <code>hledger balance</code>. Tap a row to see this month's transactions.
			</div>
		</>
	);
}
