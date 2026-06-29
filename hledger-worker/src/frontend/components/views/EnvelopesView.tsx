import { extractAmount, fmtAmount, amountClass } from '../../utils/format';
import type { EnvelopeData, PendingTxn, BalanceRow } from '../../types';

interface Props {
	data: EnvelopeData | null;
	balanceData: BalanceRow[][] | null;
	isActive: boolean;
	onEnvClick: (id: string) => void;
	onAssignClick: (txn: PendingTxn) => void;
	onScan: () => void;
	onNewEnv: () => void;
}

export default function EnvelopesView({
	data,
	balanceData,
	isActive,
	onEnvClick,
	onAssignClick,
	onScan,
	onNewEnv,
}: Props) {
	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-envelopes">
			{!data ? (
				<div className="state-msg">Tap sync to load data.</div>
			) : !data.envelopes ? (
				<div className="state-msg">Envelopes not set up.</div>
			) : (
				<EnvelopesContent
					data={data}
					balanceData={balanceData}
					onEnvClick={onEnvClick}
					onAssignClick={onAssignClick}
					onScan={onScan}
					onNewEnv={onNewEnv}
				/>
			)}
		</div>
	);
}

function EnvelopesContent({
	data,
	balanceData,
	onEnvClick,
	onAssignClick,
	onScan,
	onNewEnv,
}: {
	data: EnvelopeData;
	balanceData: BalanceRow[][] | null;
	onEnvClick: (id: string) => void;
	onAssignClick: (txn: PendingTxn) => void;
	onScan: () => void;
	onNewEnv: () => void;
}) {
	const { envelopes, balances, pending } = data;

	const allEnvTotal = envelopes.reduce((sum, env) => sum + (balances[env.id] || 0), 0);

	let hledgerNet: number | null = null;
	if (balanceData) {
		const rows = Array.isArray(balanceData[0]) ? balanceData[0] : [];
		let assets = 0;
		let liabilities = 0;
		rows.forEach(row => {
			const { val } = extractAmount(row[3]);
			if (row[0].startsWith('assets')) assets += val;
			if (row[0].startsWith('liabilities')) liabilities += val;
		});
		hledgerNet = assets + liabilities;
	}

	const diff =
		hledgerNet !== null ? Math.round((allEnvTotal - hledgerNet) * 100) / 100 : null;
	const inSync = diff !== null && Math.abs(diff) < 0.02;

	const parents = envelopes
		.filter(e => !e.parent)
		.sort((a, b) => (a.sort_order ?? 99) - (b.sort_order ?? 99));

	const pendingSorted = [...pending].sort((a, b) =>
		(b.date || '').localeCompare(a.date || '')
	);

	return (
		<>
			<div className="env-action-bar">
				<button className="env-btn primary" onClick={onScan}>Scan Txns</button>
				<button className="env-btn outline" onClick={onNewEnv}>+ Envelope</button>
			</div>

			<div className="env-section-title">
				Pending
				{pending.length > 0 && (
					<span style={{ color: 'var(--negative)', fontWeight: 600 }}>
						{' '}({pending.length})
					</span>
				)}
			</div>

			{pending.length === 0 ? (
				<div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 300, padding: '8px 0 16px' }}>
					No pending transactions. Tap Scan Txns to check for new activity.
				</div>
			) : (
				pendingSorted.map(txn => {
					const isIncome = txn.type === 'income';
					const amtSign = isIncome ? '+' : '-';
					return (
						<div key={txn.txn_id} className="pending-item" onClick={() => onAssignClick(txn)}>
							<div className="pending-top">
								<span className="pending-desc">
									{txn.description}
									{isIncome ? (
										<span className="pending-badge income">income</span>
									) : txn.suggested_envelope ? (
										<span className="pending-badge suggested">suggested</span>
									) : (
										<span className="pending-badge expense">expense</span>
									)}
								</span>
								<span className={`pending-amount ${isIncome ? 'amount-positive' : 'amount-negative'}`}>
									{amtSign}{fmtAmount(txn.amount, '$')}
								</span>
							</div>
							<div className="pending-meta">
								{txn.date || ''}
								{txn.suggested_envelope
									? ` · suggested: ${envelopes.find(e => e.id === txn.suggested_envelope)?.name ?? txn.suggested_envelope}`
									: ''}
							</div>
						</div>
					);
				})
			)}

			<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 24, marginBottom: 4 }}>
				<div className="env-section-title" style={{ margin: 0 }}>Envelopes</div>
				<div style={{ textAlign: 'right' }}>
					<div style={{ fontSize: 15, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }} className={amountClass(allEnvTotal)}>
						{fmtAmount(allEnvTotal, '$')}
					</div>
					{diff !== null && (
						<div style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.3px', color: inSync ? 'var(--positive)' : 'var(--negative)' }}>
							{inSync
								? 'in sync'
								: `${diff > 0 ? '+' : ''}${fmtAmount(diff, '$')} vs hledger`}
						</div>
					)}
				</div>
			</div>

			{parents.map(parent => {
				const children = envelopes
					.filter(e => e.parent === parent.id)
					.sort((a, b) => (a.sort_order ?? 99) - (b.sort_order ?? 99));
				const unalloc = balances[parent.id] || 0;
				const childSum = children.reduce((s, c) => s + (balances[c.id] || 0), 0);
				const total = unalloc + childSum;

				return (
					<div key={parent.id} className="env-parent">
						<div className="env-parent-header" onClick={() => onEnvClick(parent.id)}>
							<span className="env-parent-name">{parent.name}</span>
							<span className={`env-parent-total ${amountClass(total)}`}>{fmtAmount(total, '$')}</span>
						</div>
						{children.length > 0 && (
							<div className="env-unalloc-row">
								<span>Unallocated</span>
								<span className={amountClass(unalloc)}>{fmtAmount(unalloc, '$')}</span>
							</div>
						)}
						{children.map(child => {
							const bal = balances[child.id] || 0;
							return (
								<div key={child.id} className="env-child" onClick={() => onEnvClick(child.id)}>
									<div className="env-child-left">
										<div className="env-child-name">{child.name}</div>
									</div>
									<div className="env-child-right">
										<span className={`env-child-balance ${amountClass(bal)}`}>{fmtAmount(bal, '$')}</span>
										<span className="env-child-chevron">›</span>
									</div>
								</div>
							);
						})}
					</div>
				);
			})}

			<div className="view-footer">
				Balances are virtual. Real account data is in Balance and Transactions tabs.
			</div>
		</>
	);
}
