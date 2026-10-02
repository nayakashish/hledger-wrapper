import { useCallback, useEffect, useState } from 'react';
import { amountClass } from '../../utils/format';
import { apiGet, apiPost } from '../../utils/api';
import MaskedAmount from '../MaskedAmount';
import type { EnvelopeData, ReconcileData, ReconcileItem, ReconcileKind } from '../../types';

const KIND_LABEL: Record<ReconcileKind, string> = {
	assigned_twice: 'Duplicate',
	amount_differs: 'Amount mismatch',
	dismissed: 'Dismissed',
	not_in_journal: 'Removed from journal',
	unscanned: 'Not scanned',
	pending: 'Pending',
};

// Kinds a linked adjustment resolves. The others resolve themselves once
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
	const [showHelp, setShowHelp] = useState(false);

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
			showToast(keys.length === 1 ? 'Marked as reviewed' : `${keys.length} items marked as reviewed`);
			await refresh();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
		}
	};

	if (showHelp) return <ReconcileHelp onBack={() => setShowHelp(false)} />;
	if (error) return <div className="error-msg">{error}</div>;
	if (!data) return <div className="state-msg">Loading…</div>;

	const inSync = Math.abs(data.gap) < 0.005;

	return (
		<>
			<div className="recon-summary">
				<div className={`env-detail-bal ${inSync ? 'amount-positive' : amountClass(data.gap)}`}>
					{inSync ? 'In sync' : <>{data.gap > 0 ? '+' : ''}<MaskedAmount value={data.gap} /></>}
				</div>
				<div className="recon-summary-sub">
					Envelopes <MaskedAmount value={data.envelope_total} /> · hledger <MaskedAmount value={data.hledger_total} />
				</div>
			</div>

			<div className="recon-section-head">
				<span>{data.items.length === 0 ? 'No open items' : `Open items (${data.items.length})`}</span>
				{data.items.length > 1 && (
					<button className="recon-link" onClick={() => void markReviewed(data.items.map(i => i.key))}>
						Mark all reviewed
					</button>
				)}
			</div>

			{data.items.map(item => (
				<div key={item.key} className="recon-item">
					<div className="recon-item-top">
						<div className="recon-item-main">
							<div className="recon-item-desc">{item.description}</div>
							<div className="recon-item-meta">
								<span className={`recon-badge ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
								<span>{item.date}</span>
							</div>
						</div>
						<div className={`recon-item-amt ${amountClass(item.gap)}`}>
							{item.gap > 0 ? '+' : ''}<MaskedAmount value={item.gap} />
						</div>
					</div>
					{fixing === item.key ? (
						<FixForm item={item} envData={envData} onDone={refresh} onCancel={() => setFixing(null)} showToast={showToast} />
					) : (
						<div className="recon-item-actions">
							{FIXABLE.includes(item.kind) && (
								<button className="recon-btn primary" onClick={() => setFixing(item.key)}>Fix</button>
							)}
							<button className="recon-btn" onClick={() => void markReviewed([item.key])}>Mark reviewed</button>
						</div>
					)}
				</div>
			))}

			<button className="recon-help-link" onClick={() => setShowHelp(true)}>
				<span className="recon-help-icon">?</span> How to use
			</button>
		</>
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
	const [envelope, setEnvelope] = useState(
		item.envelope && envData.envelopes.some(e => e.id === item.envelope) ? item.envelope : fallback
	);
	// The adjustment that closes the gap is its opposite.
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
			showToast('Adjustment recorded');
			await onDone();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
			setSubmitting(false);
		}
	};

	return (
		<div className="env-inline-form">
			<select className="env-inline-select" value={envelope} onChange={e => setEnvelope(e.target.value)}>
				{envData.envelopes.map(e => (
					<option key={e.id} value={e.id}>{e.name}</option>
				))}
			</select>
			<input type="number" className="env-inline-input" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
			<button className="env-inline-submit" onClick={() => void submit()} disabled={submitting}>Record adjustment</button>
			<span className="env-inline-cancel" onClick={onCancel}>Cancel</span>
		</div>
	);
}

function ReconcileHelp({ onBack }: { onBack: () => void }) {
	return (
		<div className="recon-help">
			<button className="recon-link" onClick={onBack}>‹ Back</button>

			<h3>What this shows</h3>
			<p>
				Your envelopes should always add up to what hledger says you have. When they don't, this list
				shows which transactions are off.
			</p>
			<p>The number at the top is the difference. Negative means your envelopes are short.</p>

			<h3>Item types</h3>
			<dl>
				<dt><span className="recon-badge assigned_twice">Duplicate</span></dt>
				<dd>Assigned to envelopes twice.</dd>
				<dt><span className="recon-badge amount_differs">Amount mismatch</span></dt>
				<dd>Edited in the journal after you assigned it.</dd>
				<dt><span className="recon-badge dismissed">Dismissed</span></dt>
				<dd>Dismissed, but it changed your balance.</dd>
				<dt><span className="recon-badge not_in_journal">Removed from journal</span></dt>
				<dd>Deleted or renamed in the journal after you assigned it.</dd>
				<dt><span className="recon-badge unscanned">Not scanned</span></dt>
				<dd>New since your last scan.</dd>
				<dt><span className="recon-badge pending">Pending</span></dt>
				<dd>Scanned and waiting to be assigned.</dd>
			</dl>

			<h3>Fixing items</h3>
			<ul>
				<li><b>Fix</b> adds an adjustment that balances the item out.</li>
				<li><b>Mark reviewed</b> hides the item. It comes back if its amount changes.</li>
				<li>For <b>Not scanned</b> or <b>Pending</b>, tap Scan Txns and assign it.</li>
				<li>Once you're in sync, <b>Mark all reviewed</b> clears the list so only new issues show up.</li>
			</ul>
		</div>
	);
}
