import { useRef, useEffect, useState } from 'react';
import { extractAmount, fmtAmount, amountClass } from '../../utils/format';
import { useSheetSwipe } from '../../hooks/useSheetSwipe';
import { apiPost, apiDelete } from '../../utils/api';
import type { DetailContent, EnvelopeData, Transaction, Envelope } from '../../types';

interface Props {
	content: DetailContent | null;
	envData: EnvelopeData | null;
	onClose: () => void;
	onEnvAction: () => Promise<void>;
	showToast: (msg: string, duration?: number) => void;
}

export default function DetailSheet({ content, envData, onClose, onEnvAction, showToast }: Props) {
	const isOpen = content !== null;
	const overlayRef = useRef<HTMLDivElement>(null);
	const sheetRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);

	useSheetSwipe(sheetRef, bodyRef, onClose, isOpen);

	useEffect(() => {
		if (isOpen) {
			document.body.style.overflow = 'hidden';
		} else {
			document.body.style.overflow = '';
			if (sheetRef.current) sheetRef.current.style.transform = '';
		}
	}, [isOpen]);

	const handleOverlayClick = (e: React.MouseEvent) => {
		if (e.target === overlayRef.current) onClose();
	};

	let title = '';
	let subtitle = '';
	if (content?.kind === 'transaction') {
		const txn = content.txn;
		title = txn.tdescription || txn.tpayee || '—';
		const dateStr = txn.tdate || '';
		subtitle = dateStr
			? new Date(dateStr + 'T00:00:00').toLocaleDateString('en-CA', {
					weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
				})
			: '—';
	} else if (content?.kind === 'envelope') {
		const env = envData?.envelopes.find(e => e.id === content.envId);
		title = env?.name ?? content.envId;
		const parent = env?.parent
			? envData?.envelopes.find(e => e.id === env.parent)
			: null;
		subtitle = parent ? `child of ${parent.name}` : 'parent envelope';
	} else if (content?.kind === 'new-envelope') {
		title = 'New envelope';
		subtitle = '';
	}

	return (
		<div
			ref={overlayRef}
			className={`txn-detail-overlay${isOpen ? ' open' : ''}`}
			style={{ display: isOpen ? 'flex' : 'none' }}
			onClick={handleOverlayClick}
		>
			<div ref={sheetRef} className="txn-detail-sheet">
				<div className="txn-detail-handle" />
				<div className="txn-detail-header">
					<div className="txn-detail-desc">{title}</div>
					<div className="txn-detail-date">{subtitle}</div>
				</div>
				<div ref={bodyRef} className="txn-detail-body">
					{content?.kind === 'transaction' && (
						<TxnDetailBody txn={content.txn} />
					)}
					{content?.kind === 'envelope' && envData && (
						<EnvDetailBody
							envId={content.envId}
							envData={envData}
							onClose={onClose}
							onAction={onEnvAction}
							showToast={showToast}
						/>
					)}
					{content?.kind === 'new-envelope' && envData && (
						<NewEnvBody
							envData={envData}
							onClose={onClose}
							onAction={onEnvAction}
							showToast={showToast}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

// ── Transaction detail body ───────────────────────────────────────────────────

function TxnDetailBody({ txn }: { txn: Transaction }) {
	const postings = txn.tpostings || [];
	const tcomment = (txn.tcomment || '').trim();

	const rawLines: string[] = [`${txn.tdate || ''} ${txn.tdescription || ''}`];
	if (tcomment) rawLines.push(`    ; ${tcomment}`);
	postings.forEach(p => {
		const acct = p.paccount || '';
		const { val, commodity } = extractAmount(p.pamount);
		const hasAmt = p.pamount && p.pamount.length > 0;
		const amtStr = hasAmt ? `    ${fmtAmount(val, commodity)}` : '';
		const pc = (p.pcomment || '').trim();
		rawLines.push(`    ${acct}${amtStr}`);
		if (pc) rawLines.push(`        ; ${pc}`);
	});

	return (
		<>
			{tcomment && (
				<div className="txn-detail-section">
					<div className="txn-detail-section-label">Note</div>
					<div className="txn-detail-comment-box">; {tcomment}</div>
				</div>
			)}
			<div className="txn-detail-section">
				<div className="txn-detail-section-label">Postings</div>
				{postings.map((p, i) => {
					const acct = p.paccount || '—';
					const { val, commodity } = extractAmount(p.pamount);
					const hasAmt = p.pamount && p.pamount.length > 0;
					const comment = (p.pcomment || '').trim();
					return (
						<div key={i} className="posting-row">
							<div className="posting-left">
								<div className="posting-account">{acct}</div>
								{comment && <div className="posting-comment">; {comment}</div>}
							</div>
							<div className={`posting-amount ${amountClass(val)}`}>
								{hasAmt ? fmtAmount(val, commodity) : ''}
							</div>
						</div>
					);
				})}
			</div>
			<div className="txn-detail-section">
				<div className="txn-detail-section-label">Raw entry</div>
				<pre className="txn-detail-raw">{rawLines.join('\n')}</pre>
			</div>
		</>
	);
}

// ── Envelope detail body ─────────────────────────────────────────────────────

type EnvForm = 'transfer' | 'adjust' | 'correction' | null;

function EnvDetailBody({
	envId,
	envData,
	onClose,
	onAction,
	showToast,
}: {
	envId: string;
	envData: EnvelopeData;
	onClose: () => void;
	onAction: () => Promise<void>;
	showToast: (msg: string, duration?: number) => void;
}) {
	const [activeForm, setActiveForm] = useState<EnvForm>(null);
	const [correctionTxnId, setCorrectionTxnId] = useState<string | null>(null);

	const env = envData.envelopes.find(e => e.id === envId);
	const bal = envData.balances[envId] || 0;
	const isProtected = envId === 'savings' || envId === 'chequing';
	const history = [...(envData.history || [])]
		.filter(h => h.envelope === envId)
		.reverse()
		.slice(0, 30);

	const envName = (id: string) => envData.envelopes.find(e => e.id === id)?.name ?? id;

	const handleDelete = async () => {
		if (Math.abs(bal) > 0.01) {
			showToast('Transfer balance out first before deleting', 3500);
			return;
		}
		if (!confirm(`Delete "${env?.name ?? envId}"? This cannot be undone.`)) return;
		try {
			await apiDelete(`/api/envelopes/${envId}`);
			showToast('Deleted');
			onClose();
			await onAction();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
		}
	};

	return (
		<>
			<div style={{ marginBottom: 16 }}>
				<div className={`env-detail-bal ${amountClass(bal)}`}>{fmtAmount(bal, '$')}</div>
			</div>
			<div className="env-detail-actions">
				<button
					className="env-detail-btn primary"
					onClick={() => setActiveForm(f => f === 'transfer' ? null : 'transfer')}
				>
					Transfer
				</button>
				<button
					className="env-detail-btn secondary"
					onClick={() => setActiveForm(f => f === 'adjust' ? null : 'adjust')}
				>
					Adjust
				</button>
				{!isProtected && (
					<button className="env-detail-btn danger" onClick={() => void handleDelete()}>
						Delete
					</button>
				)}
			</div>

			{activeForm === 'transfer' && (
				<TransferForm
					fromId={envId}
					envData={envData}
					onDone={async () => { setActiveForm(null); onClose(); await onAction(); }}
					onCancel={() => setActiveForm(null)}
					showToast={showToast}
				/>
			)}
			{activeForm === 'adjust' && (
				<AdjustForm
					envId={envId}
					onDone={async () => { setActiveForm(null); onClose(); await onAction(); }}
					onCancel={() => setActiveForm(null)}
					showToast={showToast}
				/>
			)}
			{activeForm === 'correction' && correctionTxnId && (
				<CorrectionForm
					txnId={correctionTxnId}
					envData={envData}
					onDone={async () => { setActiveForm(null); setCorrectionTxnId(null); onClose(); await onAction(); }}
					onCancel={() => { setActiveForm(null); setCorrectionTxnId(null); }}
					showToast={showToast}
				/>
			)}

			<div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.8px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
				History
			</div>
			{history.length === 0 ? (
				<div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 300, padding: '8px 0' }}>
					No activity yet.
				</div>
			) : (
				history.map((h, i) => {
					const pos = h.amount > 0;
					const isIncome = h.type === 'income_allocation';
					return (
						<div key={i} className="env-history-row">
							<div style={{ minWidth: 0, flex: 1 }}>
								<div className="env-history-note">
									{h.note || h.type}
									{isIncome && (
										<span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 300 }}> (income)</span>
									)}
								</div>
								<div className="env-history-date">{h.date || ''}</div>
							</div>
							<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
								<div className={`env-history-amt ${pos ? 'amount-positive' : 'amount-negative'}`}>
									{pos ? '+' : ''}{fmtAmount(h.amount, '$')}
								</div>
								{isIncome && h.txn_id && (
									<button
										onClick={() => { setCorrectionTxnId(h.txn_id!); setActiveForm('correction'); }}
										style={{
											fontFamily: "'Montserrat', sans-serif",
											fontSize: 10, fontWeight: 500,
											background: 'none', border: '1px solid var(--border)',
											borderRadius: 3, padding: '2px 6px', cursor: 'pointer',
											color: 'var(--text-muted)', touchAction: 'manipulation',
										}}
									>
										edit
									</button>
								)}
							</div>
						</div>
					);
				})
			)}
			{env && (
				<div style={{ marginTop: 24 }}>
					<div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.8px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>Config</div>
					<div className="env-config-row">
						<span className="env-config-label">ID</span>
						<span className="env-config-value">{env.id}</span>
					</div>
					<div className="env-config-row">
						<span className="env-config-label">Parent</span>
						<span className="env-config-value">{env.parent ? envName(env.parent) : '—'}</span>
					</div>
				</div>
			)}
		</>
	);
}

function TransferForm({
	fromId,
	envData,
	onDone,
	onCancel,
	showToast,
}: {
	fromId: string;
	envData: EnvelopeData;
	onDone: () => Promise<void>;
	onCancel: () => void;
	showToast: (msg: string, duration?: number) => void;
}) {
	const others = envData.envelopes.filter(e => e.id !== fromId);
	const [dest, setDest] = useState('');
	const [amount, setAmount] = useState('');
	const [note, setNote] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const submit = async () => {
		const amt = parseFloat(amount);
		if (!dest || isNaN(amt) || amt === 0) return;
		setSubmitting(true);
		try {
			await apiPost('/api/envelopes/transfer', { from_envelope: fromId, to_envelope: dest, amount: amt, note });
			showToast('Transferred');
			await onDone();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
			setSubmitting(false);
		}
	};

	return (
		<div className="env-inline-form">
			<div className="env-inline-label">Transfer to</div>
			<select className="env-inline-select" value={dest} onChange={e => setDest(e.target.value)}>
				<option value="">Select destination...</option>
				{others.map(e => (
					<option key={e.id} value={e.id}>
						{e.name} ({fmtAmount(envData.balances[e.id] || 0, '$')})
					</option>
				))}
			</select>
			<input type="number" className="env-inline-input" placeholder="Amount" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
			<input type="text" className="env-inline-input" placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} />
			<button className="env-inline-submit" onClick={() => void submit()} disabled={submitting}>Transfer</button>
			<span className="env-inline-cancel" onClick={onCancel}>Cancel</span>
		</div>
	);
}

function AdjustForm({
	envId,
	onDone,
	onCancel,
	showToast,
}: {
	envId: string;
	onDone: () => Promise<void>;
	onCancel: () => void;
	showToast: (msg: string, duration?: number) => void;
}) {
	const [amount, setAmount] = useState('');
	const [note, setNote] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const submit = async () => {
		const amt = parseFloat(amount);
		if (isNaN(amt) || amt === 0) return;
		setSubmitting(true);
		try {
			await apiPost('/api/envelopes/adjust', { envelope: envId, amount: amt, note });
			showToast('Adjusted');
			await onDone();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
			setSubmitting(false);
		}
	};

	return (
		<div className="env-inline-form">
			<div className="env-inline-label">Manual adjustment</div>
			<div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 300 }}>Positive adds, negative subtracts.</div>
			<input type="number" className="env-inline-input" placeholder="+50 or -25" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} autoFocus />
			<input type="text" className="env-inline-input" placeholder="Reason" value={note} onChange={e => setNote(e.target.value)} />
			<button className="env-inline-submit" onClick={() => void submit()} disabled={submitting}>Apply</button>
			<span className="env-inline-cancel" onClick={onCancel}>Cancel</span>
		</div>
	);
}

function CorrectionForm({
	txnId,
	envData,
	onDone,
	onCancel,
	showToast,
}: {
	txnId: string;
	envData: EnvelopeData;
	onDone: () => Promise<void>;
	onCancel: () => void;
	showToast: (msg: string, duration?: number) => void;
}) {
	const allHistory = envData.history || [];
	const txnEntries = allHistory.filter(h => h.txn_id === txnId && h.type === 'income_allocation');
	const currentSplits: Record<string, number> = {};
	txnEntries.forEach(h => { currentSplits[h.envelope] = h.amount; });
	const totalAllocated = txnEntries.reduce((s, h) => s + h.amount, 0);
	const desc = txnEntries[0]?.note || 'Income';
	const date = txnEntries[0]?.date || '';

	const [values, setValues] = useState<Record<string, string>>(() => {
		const v: Record<string, string> = {};
		envData.envelopes.forEach(e => {
			const cur = currentSplits[e.id];
			v[e.id] = cur ? cur.toFixed(2) : '';
		});
		return v;
	});
	const [submitting, setSubmitting] = useState(false);

	const submit = async () => {
		const corrections: { envelope_id: string; diff: number }[] = [];
		envData.envelopes.forEach(env => {
			const newVal = parseFloat(values[env.id] || '') || 0;
			const oldVal = currentSplits[env.id] || 0;
			const diff = Math.round((newVal - oldVal) * 100) / 100;
			if (Math.abs(diff) > 0.005) corrections.push({ envelope_id: env.id, diff });
		});
		if (corrections.length === 0) { showToast('No changes made'); onCancel(); return; }
		setSubmitting(true);
		try {
			for (const c of corrections) {
				await apiPost('/api/envelopes/adjust', {
					envelope: c.envelope_id,
					amount: c.diff,
					note: 'Income correction (' + txnId.slice(0, 20) + ')',
				});
			}
			showToast('Corrections applied');
			await onDone();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
			setSubmitting(false);
		}
	};

	if (txnEntries.length === 0) {
		return <div className="error-msg">No allocation found for this transaction.</div>;
	}

	return (
		<div className="env-inline-form" style={{ marginTop: 12 }}>
			<div className="env-inline-label">Correct income allocation</div>
			<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, marginBottom: 10 }}>
				{desc} on {date} — total {fmtAmount(totalAllocated, '$')}<br />
				Adjust any amounts. Changes are additive adjustments.
			</div>
			{envData.envelopes.map(env => (
				<div key={env.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
					<span style={{ fontSize: 13, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{env.name}</span>
					{currentSplits[env.id] && (
						<span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, flexShrink: 0 }}>
							was {fmtAmount(currentSplits[env.id], '$')}
						</span>
					)}
					<input
						type="number"
						step="0.01"
						placeholder="new amt"
						value={values[env.id] || ''}
						onChange={e => setValues(prev => ({ ...prev, [env.id]: e.target.value }))}
						style={{
							fontFamily: "'Montserrat', sans-serif",
							fontSize: 13, width: 80, border: '1px solid var(--border)',
							borderRadius: 4, padding: '6px 8px', textAlign: 'right',
							background: 'var(--surface)', color: 'var(--text)', outline: 'none',
						}}
					/>
				</div>
			))}
			<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, padding: '8px 0' }}>
				Note: this creates adjustment entries for the differences. History is preserved.
			</div>
			<button className="env-inline-submit" style={{ marginTop: 10 }} onClick={() => void submit()} disabled={submitting}>
				Apply corrections
			</button>
			<span className="env-inline-cancel" onClick={onCancel}>Cancel</span>
		</div>
	);
}

// ── New envelope body ────────────────────────────────────────────────────────

function NewEnvBody({
	envData,
	onClose,
	onAction,
	showToast,
}: {
	envData: EnvelopeData;
	onClose: () => void;
	onAction: () => Promise<void>;
	showToast: (msg: string, duration?: number) => void;
}) {
	const parents = envData.envelopes.filter((e: Envelope) => !e.parent);
	const [name, setName] = useState('');
	const [parentId, setParentId] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const submit = async () => {
		if (!name.trim()) return;
		setSubmitting(true);
		try {
			await apiPost('/api/envelopes/create', { name: name.trim(), parent: parentId || null });
			showToast('Envelope created');
			onClose();
			await onAction();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
			setSubmitting(false);
		}
	};

	return (
		<div style={{ padding: '4px 0 16px' }}>
			<div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.8px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Name</div>
			<input
				type="text"
				className="env-inline-input"
				placeholder="e.g. Car Insurance"
				value={name}
				onChange={e => setName(e.target.value)}
				autoFocus
				style={{ marginBottom: 16 }}
			/>
			<div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.8px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Parent</div>
			<select className="env-inline-select" value={parentId} onChange={e => setParentId(e.target.value)} style={{ marginBottom: 20 }}>
				<option value="">No parent (top-level)</option>
				{parents.map(e => (
					<option key={e.id} value={e.id}>{e.name}</option>
				))}
			</select>
			<button className="env-inline-submit" onClick={() => void submit()} disabled={submitting || !name.trim()}>
				Create envelope
			</button>
		</div>
	);
}
