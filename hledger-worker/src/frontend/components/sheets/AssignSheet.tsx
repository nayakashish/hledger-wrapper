import { useState } from 'react';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { fmtAmount, amountClass } from '../../utils/format';
import { apiPost } from '../../utils/api';
import type { PendingTxn, EnvelopeData } from '../../types';

interface Props {
	txn: PendingTxn | null;
	envData: EnvelopeData | null;
	onClose: () => void;
	onSuccess: () => Promise<void>;
	showToast: (msg: string, duration?: number) => void;
}

export default function AssignSheet({ txn, envData, onClose, onSuccess, showToast }: Props) {
	const isOpen = txn !== null && envData !== null;

	useBodyScrollLock(isOpen);

	if (!isOpen || !txn || !envData) return null;

	return (
		<div className="assign-sheet">
			<div className="assign-sheet-inner">
				<div className="assign-header">
					<span className="assign-title">
						{txn.type === 'income' ? 'Allocate income' : 'Assign expense'}
					</span>
					<button className="assign-close" onClick={onClose}>✕</button>
				</div>
				<div className="assign-body">
					<div className="assign-txn-info">
						<div className="assign-txn-desc">{txn.description}</div>
						<div className="assign-txn-meta">
							{txn.date || ''} · {(txn.accounts || []).filter(Boolean).join(', ')}
						</div>
						<div className={`assign-txn-amount ${txn.type === 'income' ? 'amount-positive' : 'amount-negative'}`}>
							{txn.type === 'income' ? '+' : '-'}{fmtAmount(txn.amount, '$')}
						</div>
					</div>

					{txn.type === 'income' ? (
						<IncomeSplit txn={txn} envData={envData} onClose={onClose} onSuccess={onSuccess} showToast={showToast} />
					) : (
						<ExpenseAssign txn={txn} envData={envData} onClose={onClose} onSuccess={onSuccess} showToast={showToast} />
					)}
				</div>
			</div>
		</div>
	);
}

// ── Income split ─────────────────────────────────────────────────────────────

function IncomeSplit({
	txn,
	envData,
	onClose,
	onSuccess,
	showToast,
}: {
	txn: PendingTxn;
	envData: EnvelopeData;
	onClose: () => void;
	onSuccess: () => Promise<void>;
	showToast: (msg: string, duration?: number) => void;
}) {
	const defaults = envData.income_split_default || {};
	const tithePct = defaults.tithe_pct ?? 0.10;
	const savingsPct = defaults.savings ?? 0.40;

	const initSplits = () => {
		const tithe = Math.round(txn.amount * tithePct * 100) / 100;
		const savings = Math.round(txn.amount * savingsPct * 100) / 100;
		const chequing = Math.round((txn.amount - tithe - savings) * 100) / 100;
		const presets: Record<string, number> = { tithe, savings, chequing };
		const init: Record<string, string> = {};
		envData.envelopes.forEach(e => {
			const p = presets[e.id];
			init[e.id] = p && p > 0 ? p.toFixed(2) : '';
		});
		return init;
	};

	const [splits, setSplits] = useState<Record<string, string>>(initSplits);
	const [submitting, setSubmitting] = useState(false);

	const assigned = Object.values(splits).reduce((s, v) => s + (parseFloat(v) || 0), 0);
	const remainder = Math.round((txn.amount - assigned) * 100) / 100;
	const balanced = Math.abs(remainder) < 0.01;

	const setSplit = (envId: string, val: string) =>
		setSplits(prev => ({ ...prev, [envId]: val }));

	const resetDefaults = () => setSplits(initSplits());
	const clearAll = () => setSplits(Object.fromEntries(envData.envelopes.map(e => [e.id, ''])));

	const autoBalance = () => {
		if (balanced) { showToast('Already balanced'); return; }
		const target = envData.envelopes.find(e => e.id === 'chequing') || envData.envelopes[0];
		if (!target) return;
		const cur = parseFloat(splits[target.id] || '') || 0;
		const newVal = Math.round((cur + remainder) * 100) / 100;
		setSplits(prev => ({ ...prev, [target.id]: newVal > 0 ? newVal.toFixed(2) : '0.00' }));
		showToast(
			remainder > 0
				? `+${fmtAmount(remainder, '$')} added to ${target.name}`
				: `${fmtAmount(Math.abs(remainder), '$')} removed from ${target.name}`
		);
	};

	const handleSubmit = async () => {
		const entries = envData.envelopes
			.map(e => ({ envelope_id: e.id, amount: parseFloat(splits[e.id] || '') || 0 }))
			.filter(x => x.amount !== 0);
		setSubmitting(true);
		try {
			await apiPost('/api/envelopes/assign', { txn_id: txn.txn_id, splits: entries });
			showToast('Income allocated');
			onClose();
			await onSuccess();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
			setSubmitting(false);
		}
	};

	const handleDismiss = async () => {
		try {
			await apiPost('/api/envelopes/dismiss', { txn_id: txn.txn_id });
			showToast('Dismissed');
			onClose();
			await onSuccess();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
		}
	};

	return (
		<>
			<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, marginBottom: 12 }}>
				Split this income across envelopes.
			</div>
			<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
				{[
					{ label: 'Reset defaults', action: resetDefaults, accent: false },
					{ label: 'Clear all', action: clearAll, accent: false },
					{ label: 'Auto-balance', action: autoBalance, accent: true },
				].map(btn => (
					<button
						key={btn.label}
						onClick={btn.action}
						style={{
							fontFamily: "'Montserrat', sans-serif",
							fontSize: 11, fontWeight: 600, letterSpacing: '0.3px', textTransform: 'uppercase',
							background: btn.accent ? 'var(--accent)' : 'var(--bg)',
							color: btn.accent ? '#fff' : 'var(--text)',
							border: '1px solid var(--border)', borderRadius: 4,
							padding: '6px 10px', cursor: 'pointer', touchAction: 'manipulation', flexShrink: 0,
						}}
					>
						{btn.label}
					</button>
				))}
			</div>

			{envData.envelopes.map(env => (
				<div key={env.id} className="assign-split-row">
					<span className="assign-split-name">{env.name}</span>
					<input
						type="number"
						className="assign-split-input"
						step="0.01"
						placeholder="0.00"
						value={splits[env.id] || ''}
						onChange={e => setSplit(env.id, e.target.value)}
					/>
				</div>
			))}

			<div className={`assign-remainder${remainder < -0.01 ? ' warn' : ''}`}>
				{balanced
					? 'Fully allocated'
					: remainder > 0
					? `${fmtAmount(remainder, '$')} unassigned`
					: `${fmtAmount(Math.abs(remainder), '$')} over-allocated`}
			</div>

			<button
				className="assign-confirm"
				disabled={!balanced || submitting}
				onClick={() => void handleSubmit()}
			>
				{submitting ? 'Saving...' : 'Allocate income'}
			</button>
			<button className="assign-dismiss" onClick={() => void handleDismiss()}>
				Dismiss without assigning
			</button>
		</>
	);
}

// ── Expense assign ────────────────────────────────────────────────────────────

function ExpenseAssign({
	txn,
	envData,
	onClose,
	onSuccess,
	showToast,
}: {
	txn: PendingTxn;
	envData: EnvelopeData;
	onClose: () => void;
	onSuccess: () => Promise<void>;
	showToast: (msg: string, duration?: number) => void;
}) {
	const [envId, setEnvId] = useState(txn.suggested_envelope || '');
	const [note, setNote] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = async () => {
		if (!envId) return;
		setSubmitting(true);
		try {
			await apiPost('/api/envelopes/assign', { txn_id: txn.txn_id, envelope_id: envId, note });
			showToast('Assigned');
			onClose();
			await onSuccess();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
			setSubmitting(false);
		}
	};

	const handleDismiss = async () => {
		try {
			await apiPost('/api/envelopes/dismiss', { txn_id: txn.txn_id });
			showToast('Dismissed');
			onClose();
			await onSuccess();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
		}
	};

	return (
		<>
			<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, marginBottom: 12 }}>
				Choose which envelope absorbs this expense.
			</div>
			<select
				className="env-inline-select"
				value={envId}
				onChange={e => setEnvId(e.target.value)}
				style={{ marginBottom: 16 }}
			>
				<option value="">Select envelope...</option>
				{envData.envelopes.map(e => (
					<option key={e.id} value={e.id}>
						{e.name}  ({fmtAmount(envData.balances[e.id] || 0, '$')})
					</option>
				))}
			</select>
			<input
				type="text"
				className="env-inline-input"
				placeholder="Note (optional)"
				value={note}
				onChange={e => setNote(e.target.value)}
				style={{ marginBottom: 16 }}
			/>
			<button className="assign-confirm" disabled={!envId || submitting} onClick={() => void handleSubmit()}>
				{submitting ? 'Saving...' : 'Confirm'}
			</button>
			<button className="assign-dismiss" onClick={() => void handleDismiss()}>
				Dismiss without assigning
			</button>
		</>
	);
}
