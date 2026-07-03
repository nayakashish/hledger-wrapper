import { useState, useEffect, useCallback } from 'react';
import { fmtAmount } from '../../utils/format';
import { apiGet, apiPost } from '../../utils/api';
import type { InboxItem, InboxResponse } from '../../types';

interface Props {
	isOpen: boolean;
	onClose: () => void;
	onChange: () => Promise<void>;
	showToast: (msg: string, duration?: number) => void;
}

const CONFIDENCE_LABELS: Record<string, string> = {
	high: 'High',
	medium: 'Medium',
	low: 'Low',
};

function entryText(item: InboxItem): string {
	const s = item.suggestion;
	const cur = item.currency || '$';
	const fmt = (n: number) => (n < 0 ? '-' : '') + cur + Math.abs(n).toFixed(2);
	return (
		`${item.txn_date} ${s.description}\n` +
		`    ${s.account1}    ${fmt(s.amount1)}\n` +
		`    ${s.account2}    ${fmt(s.amount2)}`
	);
}

export default function InboxSheet({ isOpen, onClose, onChange, showToast }: Props) {
	const [items, setItems] = useState<InboxItem[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [selected, setSelected] = useState<InboxItem | null>(null);
	const [editText, setEditText] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		document.body.style.overflow = isOpen ? 'hidden' : '';
	}, [isOpen]);

	const loadItems = useCallback(async () => {
		setLoading(true);
		try {
			const r = await apiGet<InboxResponse>('/api/inbox');
			setItems(r.items || []);
		} catch (e) {
			showToast('Inbox failed: ' + (e instanceof Error ? e.message : String(e)), 4000);
			setItems([]);
		} finally {
			setLoading(false);
		}
	}, [showToast]);

	useEffect(() => {
		if (isOpen) {
			setSelected(null);
			setEditText(null);
			void loadItems();
		}
	}, [isOpen, loadItems]);

	if (!isOpen) return null;

	const backToList = () => {
		setSelected(null);
		setEditText(null);
	};

	const removeLocally = (id: string) => {
		setItems(prev => (prev ? prev.filter(i => i.id !== id) : prev));
		backToList();
	};

	const handlePost = async (item: InboxItem) => {
		setSubmitting(true);
		try {
			await apiPost(
				'/api/inbox/post',
				editText !== null ? { id: item.id, raw_entry: editText } : { id: item.id }
			);
			showToast('Posted to journal');
			removeLocally(item.id);
			await onChange();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
		} finally {
			setSubmitting(false);
		}
	};

	const handleDismiss = async (item: InboxItem) => {
		setSubmitting(true);
		try {
			await apiPost('/api/inbox/dismiss', { id: item.id });
			showToast('Dismissed');
			removeLocally(item.id);
			await onChange();
		} catch (e) {
			showToast('Error: ' + (e instanceof Error ? e.message : String(e)), 4000);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="assign-sheet">
			<div className="assign-sheet-inner">
				<div className="assign-header">
					<div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
						{selected && (
							<button className="assign-close" onClick={backToList} aria-label="Back to inbox">
								←
							</button>
						)}
						<span className="assign-title">{selected ? 'Review transaction' : 'Inbox'}</span>
					</div>
					<button className="assign-close" onClick={onClose}>✕</button>
				</div>
				<div className="assign-body">
					{selected ? (
						<ReviewItem
							item={selected}
							editText={editText}
							setEditText={setEditText}
							submitting={submitting}
							onPost={handlePost}
							onDismiss={handleDismiss}
						/>
					) : (
						<ItemList items={items} loading={loading} onSelect={setSelected} />
					)}
				</div>
			</div>
		</div>
	);
}

// ── List level ────────────────────────────────────────────────────────────────

function ItemList({
	items,
	loading,
	onSelect,
}: {
	items: InboxItem[] | null;
	loading: boolean;
	onSelect: (item: InboxItem) => void;
}) {
	if (loading && items === null) {
		return <div className="inbox-empty">Loading...</div>;
	}
	if (!items || items.length === 0) {
		return <div className="inbox-empty">No pending transactions</div>;
	}
	return (
		<>
			{items.map(item => (
				<button key={item.id} className="inbox-row" onClick={() => onSelect(item)}>
					<div className="inbox-row-main">
						<div className="inbox-row-desc">
							{item.parsed === false ? (item.raw_subject || 'Unparsed alert') : item.merchant_clean}
						</div>
						<div className="inbox-row-meta">
							{item.txn_date}
							{item.card_last4 ? ` · card ${item.card_last4}` : ''}
						</div>
					</div>
					{item.journal_match ? (
						<span className="inbox-chip journal">In journal?</span>
					) : (
						<span className={`inbox-chip ${item.suggestion.confidence}`}>
							{CONFIDENCE_LABELS[item.suggestion.confidence] || item.suggestion.confidence}
						</span>
					)}
					<span className="inbox-row-amount amount-negative">
						{fmtAmount(Math.abs(item.amount), item.currency || '$')}
					</span>
				</button>
			))}
		</>
	);
}

// ── Review level ──────────────────────────────────────────────────────────────

function ReviewItem({
	item,
	editText,
	setEditText,
	submitting,
	onPost,
	onDismiss,
}: {
	item: InboxItem;
	editText: string | null;
	setEditText: (t: string | null) => void;
	submitting: boolean;
	onPost: (item: InboxItem) => Promise<void>;
	onDismiss: (item: InboxItem) => Promise<void>;
}) {
	const unparsed = item.parsed === false;
	const editing = editText !== null;

	return (
		<>
			<div className="assign-txn-info">
				<div className="assign-txn-desc">
					{unparsed ? (item.raw_subject || 'Unparsed alert') : item.merchant_raw}
				</div>
				<div className="assign-txn-meta">
					{item.txn_date}
					{item.card_last4 ? ` · card ending ${item.card_last4}` : ''}
					{item.bank ? ` · ${item.bank.toUpperCase()}` : ''}
				</div>
				<div className="assign-txn-amount amount-negative">
					-{fmtAmount(Math.abs(item.amount), item.currency || '$')}
				</div>
			</div>

			{item.journal_match && (
				<div className="inbox-journal-banner">
					<strong>Possibly already in journal:</strong>{' '}
					{item.journal_match.date} {item.journal_match.description}{' '}
					{fmtAmount(Math.abs(item.amount), item.currency || '$')}
				</div>
			)}

			{unparsed ? (
				<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, marginBottom: 12 }}>
					This alert could not be parsed. Edit the entry below before posting.
				</div>
			) : (
				<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, marginBottom: 12 }}>
					Suggested entry ({CONFIDENCE_LABELS[item.suggestion.confidence] || item.suggestion.confidence}{' '}
					confidence, {item.suggestion.matched_on})
				</div>
			)}

			<textarea
				className="preview-entry"
				rows={6}
				spellCheck={false}
				readOnly={!editing}
				value={editing ? editText : entryText(item)}
				onChange={e => setEditText(e.target.value)}
				onClick={() => {
					if (!editing) setEditText(entryText(item));
				}}
			/>

			<button
				className="assign-confirm"
				disabled={submitting}
				onClick={() => void onPost(item)}
			>
				{submitting ? 'Saving...' : editing ? 'Post edited entry' : 'Post to journal'}
			</button>
			<button
				className="assign-dismiss"
				disabled={submitting}
				onClick={() => (editing ? setEditText(null) : setEditText(entryText(item)))}
				style={{ marginBottom: 10 }}
			>
				{editing ? 'Cancel edit' : 'Edit entry'}
			</button>
			<button
				className="assign-dismiss inbox-dismiss"
				disabled={submitting}
				onClick={() => void onDismiss(item)}
			>
				Dismiss
			</button>
		</>
	);
}
