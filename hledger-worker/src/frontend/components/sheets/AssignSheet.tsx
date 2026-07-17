import { useState } from 'react';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { fmtAmount, amountClass } from '../../utils/format';
import { apiPost } from '../../utils/api';
import { allocateByPercent, percentOfTotal } from '../../utils/splitAllocation';
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

// ── Shared toggle button group (Single/Split, Amount/Percent) ────────────────

function ToggleGroup<T extends string>({
	options,
	value,
	onChange,
}: {
	options: { value: T; label: string }[];
	value: T;
	onChange: (v: T) => void;
}) {
	return (
		<div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
			{options.map(opt => (
				<button
					key={opt.value}
					onClick={() => onChange(opt.value)}
					style={{
						fontFamily: "'Montserrat', sans-serif",
						fontSize: 11, fontWeight: 600, letterSpacing: '0.3px', textTransform: 'uppercase',
						background: value === opt.value ? 'var(--accent)' : 'var(--bg)',
						color: value === opt.value ? '#fff' : 'var(--text)',
						border: '1px solid var(--border)', borderRadius: 4,
						padding: '6px 12px', cursor: 'pointer', touchAction: 'manipulation', flex: 1,
					}}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}

// ── Shared split editor (amount or percent entry, per envelope) ──────────────

type SplitMode = 'amount' | 'percent';

function SplitEditor({
	txn,
	envData,
	initAmounts,
	showDefaultsButton,
	onResetDefaults,
	helperText,
	submitLabel,
	onSubmit,
	onDismiss,
	showToast,
}: {
	txn: PendingTxn;
	envData: EnvelopeData;
	initAmounts: () => Record<string, string>;
	showDefaultsButton?: boolean;
	onResetDefaults?: () => Record<string, string>;
	helperText: string;
	submitLabel: string;
	onSubmit: (splits: { envelope_id: string; amount: number }[]) => Promise<void>;
	onDismiss: () => Promise<void>;
	showToast: (msg: string, duration?: number) => void;
}) {
	const [mode, setMode] = useState<SplitMode>('amount');
	const [amountValues, setAmountValues] = useState<Record<string, string>>(initAmounts);
	const [percentValues, setPercentValues] = useState<Record<string, string>>({});
	const [submitting, setSubmitting] = useState(false);

	const percentInputs = Object.fromEntries(
		envData.envelopes.map(e => [e.id, parseFloat(percentValues[e.id] || '') || 0])
	);

	// The dollar amounts actually assigned, regardless of which mode the
	// user is typing in — percent mode never leaves this component.
	const derivedAmounts: Record<string, number> =
		mode === 'amount'
			? Object.fromEntries(envData.envelopes.map(e => [e.id, parseFloat(amountValues[e.id] || '') || 0]))
			: allocateByPercent(txn.amount, percentInputs);

	const assigned = Object.values(derivedAmounts).reduce((s, v) => s + v, 0);
	const remainder = Math.round((txn.amount - assigned) * 100) / 100;
	const balanced = Math.abs(remainder) < 0.01;

	const setValue = (envId: string, val: string) => {
		if (mode === 'amount') setAmountValues(prev => ({ ...prev, [envId]: val }));
		else setPercentValues(prev => ({ ...prev, [envId]: val }));
	};

	const switchMode = (next: SplitMode) => {
		if (next === mode) return;
		if (next === 'percent') {
			const hasPercentInput = Object.values(percentValues).some(v => v.trim() !== '');
			if (!hasPercentInput) {
				const seeded: Record<string, string> = {};
				envData.envelopes.forEach(e => {
					const amt = parseFloat(amountValues[e.id] || '') || 0;
					seeded[e.id] = amt ? percentOfTotal(amt, txn.amount).toFixed(2) : '';
				});
				setPercentValues(seeded);
			}
		} else {
			const hasAmountInput = Object.values(amountValues).some(v => v.trim() !== '');
			if (!hasAmountInput) {
				const allocated = allocateByPercent(txn.amount, percentInputs);
				const seeded: Record<string, string> = {};
				envData.envelopes.forEach(e => {
					seeded[e.id] = allocated[e.id] ? allocated[e.id].toFixed(2) : '';
				});
				setAmountValues(seeded);
			}
		}
		setMode(next);
	};

	const clearAll = () => {
		setAmountValues(Object.fromEntries(envData.envelopes.map(e => [e.id, ''])));
		setPercentValues(Object.fromEntries(envData.envelopes.map(e => [e.id, ''])));
	};

	const resetDefaults = () => {
		if (!onResetDefaults) return;
		setAmountValues(onResetDefaults());
		setPercentValues({});
		setMode('amount');
	};

	const autoBalance = () => {
		if (balanced) { showToast('Already balanced'); return; }
		const target =
			envData.envelopes.find(e => e.id === txn.suggested_envelope) ||
			envData.envelopes.find(e => e.id === 'chequing') ||
			envData.envelopes[0];
		if (!target) return;
		if (mode === 'amount') {
			const cur = parseFloat(amountValues[target.id] || '') || 0;
			const newVal = Math.round((cur + remainder) * 100) / 100;
			setAmountValues(prev => ({ ...prev, [target.id]: newVal > 0 ? newVal.toFixed(2) : '0.00' }));
		} else {
			const curAmt = derivedAmounts[target.id] || 0;
			const newAmt = Math.max(0, Math.round((curAmt + remainder) * 100) / 100);
			setPercentValues(prev => ({ ...prev, [target.id]: percentOfTotal(newAmt, txn.amount).toFixed(2) }));
		}
		showToast(
			remainder > 0
				? `+${fmtAmount(remainder, '$')} added to ${target.name}`
				: `${fmtAmount(Math.abs(remainder), '$')} removed from ${target.name}`
		);
	};

	const handleSubmit = async () => {
		const entries = envData.envelopes
			.map(e => ({ envelope_id: e.id, amount: Math.round((derivedAmounts[e.id] || 0) * 100) / 100 }))
			.filter(x => x.amount !== 0);
		if (entries.length === 0) return;
		setSubmitting(true);
		try {
			await onSubmit(entries);
		} catch {
			setSubmitting(false);
		}
	};

	return (
		<>
			<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, marginBottom: 12 }}>
				{helperText}
			</div>

			<ToggleGroup
				options={[{ value: 'amount', label: '$ Amount' }, { value: 'percent', label: '% Percent' }]}
				value={mode}
				onChange={switchMode}
			/>

			<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
				{[
					...(showDefaultsButton ? [{ label: 'Reset defaults', action: resetDefaults, accent: false }] : []),
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
					{mode === 'percent' && (
						<span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, flexShrink: 0 }}>
							{fmtAmount(derivedAmounts[env.id] || 0, '$')}
						</span>
					)}
					<input
						type="number"
						className="assign-split-input"
						step="0.01"
						placeholder={mode === 'percent' ? '0' : '0.00'}
						value={(mode === 'amount' ? amountValues[env.id] : percentValues[env.id]) || ''}
						onChange={e => setValue(env.id, e.target.value)}
					/>
					{mode === 'percent' && <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>%</span>}
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
				{submitting ? 'Saving...' : submitLabel}
			</button>
			<button className="assign-dismiss" onClick={() => void onDismiss()}>
				Dismiss without assigning
			</button>
		</>
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

	const initAmounts = () => {
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

	const handleSubmit = async (splits: { envelope_id: string; amount: number }[]) => {
		try {
			await apiPost('/api/envelopes/assign', { txn_id: txn.txn_id, splits });
			showToast('Income allocated');
			onClose();
			await onSuccess();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
			throw e;
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
		<SplitEditor
			txn={txn}
			envData={envData}
			initAmounts={initAmounts}
			showDefaultsButton
			onResetDefaults={initAmounts}
			helperText="Split this income across envelopes."
			submitLabel="Allocate income"
			onSubmit={handleSubmit}
			onDismiss={handleDismiss}
			showToast={showToast}
		/>
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
	const [splitMode, setSplitMode] = useState<'single' | 'split'>('single');
	const [envId, setEnvId] = useState(txn.suggested_envelope || '');
	const [note, setNote] = useState('');
	const [submitting, setSubmitting] = useState(false);

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

	if (splitMode === 'split') {
		const initAmounts = () => {
			const init: Record<string, string> = {};
			envData.envelopes.forEach(e => { init[e.id] = ''; });
			if (txn.suggested_envelope) init[txn.suggested_envelope] = txn.amount.toFixed(2);
			return init;
		};

		const handleSplitSubmit = async (splits: { envelope_id: string; amount: number }[]) => {
			try {
				await apiPost('/api/envelopes/assign', { txn_id: txn.txn_id, splits });
				showToast('Assigned');
				onClose();
				await onSuccess();
			} catch (e) {
				showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
				throw e;
			}
		};

		return (
			<>
				<ToggleGroup
					options={[{ value: 'single', label: 'Single envelope' }, { value: 'split', label: 'Split' }]}
					value={splitMode}
					onChange={setSplitMode}
				/>
				<SplitEditor
					txn={txn}
					envData={envData}
					initAmounts={initAmounts}
					helperText="Split this expense across envelopes."
					submitLabel="Assign split"
					onSubmit={handleSplitSubmit}
					onDismiss={handleDismiss}
					showToast={showToast}
				/>
			</>
		);
	}

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

	return (
		<>
			<ToggleGroup
				options={[{ value: 'single', label: 'Single envelope' }, { value: 'split', label: 'Split' }]}
				value={splitMode}
				onChange={setSplitMode}
			/>
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
