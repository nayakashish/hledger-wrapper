import { useState, useEffect } from 'react';
import { extractAmount, fmtAmount, amountClass } from '../../utils/format';
import { currentMonth } from '../../utils/format';
import { usePrivacy } from '../../context/PrivacyContext';
import type { Amount, BalanceRow, Transaction } from '../../types';

interface Props {
	data: BalanceRow[][] | null;
	isActive: boolean;
	onTxnClick: (txn: Transaction) => void;
}

export default function BalanceView({ data, isActive, onTxnClick }: Props) {
	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-balance">
			{!data ? (
				<div className="state-msg">Tap sync to load data.</div>
			) : (
				<BalanceContent data={data} onTxnClick={onTxnClick} />
			)}
		</div>
	);
}

function BalanceContent({ data, onTxnClick }: { data: BalanceRow[][], onTxnClick: (txn: Transaction) => void }) {
	const rows = Array.isArray(data[0]) ? data[0] : [];
	if (rows.length === 0) return <div className="state-msg">No data.</div>;

	const { privacyMode } = usePrivacy();
	// accounts whose children are currently shown
	const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
	// leaf account whose transactions are shown
	const [expandedTxns, setExpandedTxns] = useState<string | null>(null);
	const [txnsByMonth, setTxnsByMonth] = useState<Record<string, Transaction[]>>({});
	const [loading, setLoading] = useState(false);

	const month = currentMonth();

	useEffect(() => {
		setExpandedAccounts(new Set());
		setExpandedTxns(null);
	}, [data]);

	// row[3] has the leaf account's own amount (flat mode: only leaf accounts are returned)
	const amountMap: Record<string, Amount[]> = {};
	rows.forEach(row => { amountMap[row[0]] = row[3]; });

	const allNames = new Set<string>();
	rows.forEach(row => {
		const parts = (row[0] as string).split(':');
		for (let i = 1; i <= parts.length; i++) allNames.add(parts.slice(0, i).join(':'));
	});

	const sorted = Array.from(allNames).sort();

	// Synthesized parents aren't in the API output — sum all their leaf descendants
	for (const name of sorted) {
		if (amountMap[name]?.length) continue;
		const byCommodity: Record<string, number> = {};
		rows.forEach(row => {
			const rowName = row[0] as string;
			if (!rowName.startsWith(name + ':')) return;
			(row[3] as Amount[]).forEach(amt => {
				byCommodity[amt.acommodity] = (byCommodity[amt.acommodity] ?? 0) + extractAmount([amt]).val;
			});
		});
		if (Object.keys(byCommodity).length) {
			amountMap[name] = Object.entries(byCommodity).map(([acommodity, aquantity]) => ({ acommodity, aquantity }));
		}
	}

	// Visible if depth ≤ 1 (one colon), or every ancestor from depth 2 up is expanded
	const isVisible = (fullName: string) => {
		const parts = fullName.split(':');
		if (parts.length <= 2) return true;
		for (let i = 2; i < parts.length; i++) {
			if (!expandedAccounts.has(parts.slice(0, i).join(':'))) return false;
		}
		return true;
	};

	const handleClick = async (fullName: string) => {
		const hasChildren = sorted.some(n => n !== fullName && n.startsWith(fullName + ':'));

		if (hasChildren) {
			setExpandedTxns(null);
			setExpandedAccounts(prev => {
				const next = new Set(prev);
				if (next.has(fullName)) {
					// collapse this node and all its expanded descendants
					for (const n of Array.from(next)) {
						if (n === fullName || n.startsWith(fullName + ':')) next.delete(n);
					}
				} else {
					next.add(fullName);
				}
				return next;
			});
			return;
		}

		// leaf: toggle transaction drilldown
		if (expandedTxns === fullName) {
			setExpandedTxns(null);
			return;
		}
		setExpandedTxns(fullName);
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

	const groups: Record<string, string[]> = {};
	const groupOrder: string[] = [];
	sorted.forEach(name => {
		const top = name.split(':')[0];
		if (!groups[top]) { groups[top] = []; groupOrder.push(top); }
		if (name !== top) groups[top].push(name);
	});

	const monthTxns = txnsByMonth[month] ?? [];

	const PRIVACY_HIDDEN_GROUPS = new Set(['assets', 'equity']);

	return (
		<>
			{groupOrder.filter(group => !privacyMode || !PRIVACY_HIDDEN_GROUPS.has(group)).map(group => (
				<div key={group}>
					<div className="section-title">{group}</div>
					{groups[group].filter(isVisible).map(fullName => {
						const depth = (fullName.match(/:/g) || []).length;
						const amounts = amountMap[fullName] || [];
						const { val, commodity } = extractAmount(amounts);
						const label = fullName.split(':').pop() || fullName;
						const indentPx = (depth - 1) * 16;
						const hasChildren = sorted.some(n => n !== fullName && n.startsWith(fullName + ':'));
						const isAccExpanded = expandedAccounts.has(fullName);
						const isTxnExpanded = expandedTxns === fullName;
						const rowTxns = monthTxns.filter(txn =>
							(txn.tpostings || []).some(p => (p.paccount || '').startsWith(fullName))
						);

						return (
							<div key={fullName}>
								<div
									className={`account-row drilldown-row${isAccExpanded || isTxnExpanded ? ' expanded' : ''}`}
									onClick={() => void handleClick(fullName)}
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
								{isTxnExpanded && (
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
			<div className="view-footer">
				Data shown via <code>hledger balance</code>. Tap a parent account to expand, or a leaf to see this month's transactions.
			</div>
		</>
	);
}
