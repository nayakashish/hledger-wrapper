import { useCallback, useEffect, useState } from 'react';
import { fmtAmount, amountClass } from '../../utils/format';
import { apiGet, apiPost } from '../../utils/api';
import MaskedAmount from '../MaskedAmount';
import type { EnvelopeData, ReconcileData, ReconcileItem, ReconcileKind } from '../../types';

// What each kind means, and what to do about it, in the user's words.
const KIND_TEXT: Record<ReconcileKind, { label: string; hint: string }> = {
	assigned_twice: { label: 'Assigned twice', hint: 'The same transaction was taken out of envelopes twice.' },
	amount_differs: { label: 'Amount differs', hint: 'Envelopes recorded a different amount than the journal has now.' },
	dismissed: { label: 'Dismissed', hint: 'Dismissed, but it moved real money.' },
	not_in_journal: { label: 'Not in journal', hint: 'Assigned, then deleted or edited in the journal.' },
	unscanned: { label: 'Not scanned', hint: 'New in the journal. Tap Scan Txns, then assign it.' },
	pending: { label: 'Pending', hint: 'Waiting in Pending. Assign it there.' },
};

// Kinds that a linked adjustment fixes. The others close themselves once
// the transaction is scanned and assigned.
const FIXABLE: ReconcileKind[] = ['assigned_twice', 'amount_differs', 'dismissed', 'not_in_journal'];

export default function ReconcileBody({
	envData,
	onAction,
	showToast,
}: {
	envData: EnvelopeData;
	onAction: () => Promise<void>;
	showToast: (msg: string, duration?: number) => void;
}) {
	const [data, setData] = useState<ReconcileData | null>(null);
	const [error, setError] = useState('');
	const [fixing, setFixing] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setData(await apiGet<ReconcileData>('/api/envelopes/reconcile'));
			setError('');
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => { void load(); }, [load]);

	const refresh = async () => {
		setFixing(null);
		await load();
		await onAction();
	};

	const markReviewed = async (keys: string[]) => {
		try {
			await apiPost('/api/envelopes/reconcile/ack', { keys });
			showToast(keys.length === 1 ? 'Marked reviewed' : `Marked ${keys.length} reviewed`);
			await refresh();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
		}
	};

	if (error) return <div className="error-msg">{error}</div>;
	if (!data) return <div className="state-msg">Checking the journal...</div>;

	const inSync = Math.abs(data.gap) < 0.005;

	return (
		<>
			<div style={{ marginBottom: 16 }}>
				<div className={`env-detail-bal ${inSync ? 'amount-positive' : amountClass(data.gap)}`}>
					{inSync ? 'In sync' : <>{data.gap > 0 ? '+' : ''}<MaskedAmount value={data.gap} /></>}
				</div>
				<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300 }}>
					Envelopes <MaskedAmount value={data.envelope_total} /> vs hledger <MaskedAmount value={data.hledger_total} />
				</div>
			</div>

			<SectionLabel>
				{data.items.length === 0 ? 'Nothing open' : `Open (${data.items.length})`}
				{data.items.length > 1 && (
					<button className="env-inline-cancel" style={{ float: 'right', background: 'none', border: 'none' }} onClick={() => void markReviewed(data.items.map(i => i.key))}>
						Mark all reviewed
					</button>
				)}
			</SectionLabel>

			{data.items.map(item => (
				<div key={item.key} className="env-history-row" style={{ display: 'block' }}>
					<div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
						<div style={{ minWidth: 0, flex: 1 }}>
							<div className="env-history-note">
								{item.description}
								<span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 300 }}> ({KIND_TEXT[item.kind].label})</span>
							</div>
							<div className="env-history-date">
								{item.date} · journal {fmtAmount(item.journal, '$')} · envelopes {fmtAmount(item.envelopes, '$')}
							</div>
						</div>
						<div className={`env-history-amt ${amountClass(item.gap)}`}>
							{item.gap > 0 ? '+' : ''}{fmtAmount(item.gap, '$')}
						</div>
					</div>
					<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, margin: '4px 0' }}>
						{KIND_TEXT[item.kind].hint}
					</div>
					{fixing === item.key ? (
						<FixForm item={item} envData={envData} onDone={refresh} onCancel={() => setFixing(null)} showToast={showToast} />
					) : (
						<div style={{ display: 'flex', gap: 12 }}>
							{FIXABLE.includes(item.kind) && (
								<button className="env-inline-cancel" style={{ background: 'none', border: 'none', padding: 0 }} onClick={() => setFixing(item.key)}>Fix</button>
							)}
							<button className="env-inline-cancel" style={{ background: 'none', border: 'none', padding: 0 }} onClick={() => void markReviewed([item.key])}>Mark reviewed</button>
						</div>
					)}
				</div>
			))}

			<div style={{ marginTop: 20 }}>
				<SectionLabel>Also in the total</SectionLabel>
				<SummaryRow label="Reviewed earlier" value={data.reviewed} />
				<SummaryRow label="Adjustments not tied to a transaction" value={data.unlinked_adjustments} />
				{Math.abs(data.store_mismatch) >= 0.005 && (
					<SummaryRow label="Balances history doesn't explain" value={data.store_mismatch} />
				)}
			</div>
			<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, padding: '12px 0' }}>
				Fix posts an adjustment tied to the transaction, so the item closes. Mark reviewed hides an item until its gap changes.
			</div>
		</>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.8px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>
			{children}
		</div>
	);
}

function SummaryRow({ label, value }: { label: string; value: number }) {
	return (
		<div className="env-config-row">
			<span className="env-config-label">{label}</span>
			<span className={`env-config-value ${amountClass(value)}`}><MaskedAmount value={value} /></span>
		</div>
	);
}

function FixForm({
	item,
	envData,
	onDone,
	onCancel,
	showToast,
}: {
	item: ReconcileItem;
	envData: EnvelopeData;
	onDone: () => Promise<void>;
	onCancel: () => void;
	showToast: (msg: string, duration?: number) => void;
}) {
	const fallback = envData.envelopes.find(e => e.id === 'chequing')?.id ?? envData.envelopes[0]?.id ?? '';
	const [envelope, setEnvelope] = useState(item.envelope ?? fallback);
	// The adjustment that closes the gap: the opposite of it.
	const [amount, setAmount] = useState((-item.gap).toFixed(2));
	const [submitting, setSubmitting] = useState(false);

	const submit = async () => {
		const amt = parseFloat(amount);
		if (!envelope || isNaN(amt) || amt === 0) return;
		setSubmitting(true);
		try {
			await apiPost('/api/envelopes/adjust', {
				envelope,
				amount: amt,
				note: `Reconcile: ${item.description} ${item.date}`,
				txn_id: item.txn_id,
			});
			showToast('Fixed');
			await onDone();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
			setSubmitting(false);
		}
	};

	return (
		<div className="env-inline-form">
			<div className="env-inline-label">Adjust envelope</div>
			<select className="env-inline-select" value={envelope} onChange={e => setEnvelope(e.target.value)}>
				{envData.envelopes.map(e => (
					<option key={e.id} value={e.id}>{e.name}</option>
				))}
			</select>
			<input type="number" className="env-inline-input" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
			<button className="env-inline-submit" onClick={() => void submit()} disabled={submitting}>Apply</button>
			<span className="env-inline-cancel" onClick={onCancel}>Cancel</span>
		</div>
	);
}
