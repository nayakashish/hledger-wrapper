import { useState, useEffect, useCallback, useRef } from 'react';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { fmtAmount } from '../../utils/format';
import { apiGet, apiPost } from '../../utils/api';
import type { InboxItem, InboxResponse, InboxRule } from '../../types';

interface Props {
	isOpen: boolean;
	onClose: () => void;
	onChange: () => Promise<void>;
	accountsList: string[];
	showToast: (msg: string, duration?: number) => void;
}

const CONFIDENCE_LABELS: Record<string, string> = {
	high: 'High',
	medium: 'Medium',
	low: 'Low',
};

// The entry posted from the fast path: user's own title, with the user note
// and the bank's raw merchant descriptor preserved as an inline comment.
function buildEntry(item: InboxItem, title: string, note: string, account1: string): string {
	const s = item.suggestion;
	const cur = item.currency || '$';
	const fmt = (n: number) => (n < 0 ? '-' : '') + cur + Math.abs(n).toFixed(2);
	const desc = title.trim() || s.description;
	const acct1 = account1.trim() || s.account1;
	const commentParts = [
		note.trim(),
		item.merchant_raw && item.merchant_raw !== desc ? item.merchant_raw : '',
	].filter(Boolean);
	const comment = commentParts.length ? `  ; ${commentParts.join(' · ')}` : '';
	return (
		`${item.txn_date} ${desc}${comment}\n` +
		`    ${acct1}    ${fmt(s.amount1)}\n` +
		`    ${s.account2}    ${fmt(s.amount2)}`
	);
}

// The raw-edit textarea holds the entry without the note, so the note stays
// editable in its own field; it is merged into the first line at post time.
function appendNote(entry: string, note: string): string {
	const n = note.trim();
	if (!n) return entry;
	const lines = entry.split('\n');
	lines[0] = lines[0].includes(';') ? `${lines[0]} · ${n}` : `${lines[0]}  ; ${n}`;
	return lines.join('\n');
}

export default function InboxSheet({ isOpen, onClose, onChange, accountsList, showToast }: Props) {
	const [items, setItems] = useState<InboxItem[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [selected, setSelected] = useState<InboxItem | null>(null);
	const [submitting, setSubmitting] = useState(false);

	useBodyScrollLock(isOpen);

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
			void loadItems();
		}
	}, [isOpen, loadItems]);

	if (!isOpen) return null;

	const backToList = () => setSelected(null);

	const removeLocally = (id: string) => {
		setItems(prev => (prev ? prev.filter(i => i.id !== id) : prev));
		backToList();
	};

	const handlePost = async (item: InboxItem, rawEntry: string, rule: InboxRule | null) => {
		setSubmitting(true);
		try {
			await apiPost('/api/inbox/post', { id: item.id, raw_entry: rawEntry });
			showToast(rule ? 'Posted + merchant saved' : 'Posted to journal');
			if (rule) {
				try {
					await apiPost('/api/inbox/rule', rule);
				} catch (e) {
					showToast('Posted, but saving merchant rule failed: ' + (e instanceof Error ? e.message : String(e)), 4000);
				}
			}
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
							key={selected.id}
							item={selected}
							accountsList={accountsList}
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
	accountsList,
	submitting,
	onPost,
	onDismiss,
}: {
	item: InboxItem;
	accountsList: string[];
	submitting: boolean;
	onPost: (item: InboxItem, rawEntry: string, rule: InboxRule | null) => Promise<void>;
	onDismiss: (item: InboxItem) => Promise<void>;
}) {
	const unparsed = item.parsed === false;
	const fromRule = item.suggestion.matched_on === 'rule';

	const [title, setTitle] = useState(item.suggestion.description);
	const [note, setNote] = useState('');
	const [account1, setAccount1] = useState(item.suggestion.account1);
	const [rawText, setRawText] = useState<string | null>(null);
	const [remember, setRemember] = useState(false);

	const editing = rawText !== null;
	const entry = editing ? rawText : buildEntry(item, title, note, account1);

	// The rule saved by "Remember merchant": pattern from the cleaned bank
	// descriptor, title/account from whatever entry is actually being posted.
	const deriveRule = (): InboxRule | null => {
		if (!remember || !item.merchant_clean) return null;
		let description = title.trim();
		let account = account1.trim() || item.suggestion.account1;
		if (editing && rawText) {
			const lines = rawText.trim().split('\n');
			const descMatch = (lines[0] || '').match(/^\S+\s+(.*?)(?:\s*;.*)?$/);
			if (descMatch) description = descMatch[1].trim();
			const acctMatch = (lines[1] || '').trim().match(/^(\S+)/);
			if (acctMatch) account = acctMatch[1];
		}
		if (!description || !account) return null;
		return { pattern: item.merchant_clean, account, description };
	};

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

			{!editing && (
				<>
					<div className="inbox-field-label">Title</div>
					<input
						type="text"
						className="env-inline-input"
						value={title}
						onChange={e => setTitle(e.target.value)}
						autoFocus={!fromRule && !unparsed}
						onFocus={e => e.target.select()}
						style={{ marginBottom: 12 }}
					/>
				</>
			)}
			<div className="inbox-field-label">Note</div>
			<input
				type="text"
				className="env-inline-input"
				placeholder="Optional — becomes an inline ; comment"
				value={note}
				onChange={e => setNote(e.target.value)}
				style={{ marginBottom: 12 }}
			/>
			{!editing && (
				<>
					<div className="inbox-field-label">Category</div>
					<CategoryField
						value={account1}
						accountsList={accountsList}
						onChange={setAccount1}
					/>
				</>
			)}

			{unparsed ? (
				<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, marginBottom: 6 }}>
					This alert could not be parsed. Edit the entry below before posting.
				</div>
			) : (
				<div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 300, marginBottom: 6 }}>
					{CONFIDENCE_LABELS[item.suggestion.confidence] || item.suggestion.confidence} confidence
					({item.suggestion.matched_on})
				</div>
			)}

			<textarea
				className="preview-entry"
				rows={6}
				spellCheck={false}
				readOnly={!editing}
				value={entry}
				onChange={e => setRawText(e.target.value)}
				onClick={() => {
					if (!editing) setRawText(buildEntry(item, title, '', account1));
				}}
			/>

			<label className="inbox-remember">
				<input
					type="checkbox"
					checked={remember}
					onChange={e => setRemember(e.target.checked)}
				/>
				<span>
					Remember merchant — future “{item.merchant_clean}” alerts use this title and category
				</span>
			</label>

			<button
				className="assign-confirm inbox-post"
				disabled={submitting}
				onClick={() => void onPost(item, editing ? appendNote(entry, note) : entry, deriveRule())}
			>
				{submitting ? 'Saving...' : editing ? 'Post edited entry' : 'Post to journal'}
			</button>
			<button
				className="assign-dismiss"
				disabled={submitting}
				onClick={() => (editing ? setRawText(null) : setRawText(buildEntry(item, title, '', account1)))}
				style={{ marginBottom: 10 }}
			>
				{editing ? 'Cancel edit' : 'Edit accounts / amounts'}
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

// ── Category field ────────────────────────────────────────────────────────────

// Chart-of-accounts autocomplete for the expense side of the entry. Matches
// each space-separated token as a substring ("food din" → expenses:food:diningout),
// listing expenses:* accounts before everything else.
function CategoryField({
	value,
	accountsList,
	onChange,
}: {
	value: string;
	accountsList: string[];
	onChange: (v: string) => void;
}) {
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const inputRef = useRef<HTMLInputElement>(null);

	const filterAccounts = (val: string): string[] => {
		const tokens = val.trim().toLowerCase().split(/\s+/).filter(Boolean);
		if (tokens.length === 0 || accountsList.length === 0) return [];
		return accountsList
			.filter(a => {
				const lower = a.toLowerCase();
				return a !== val && tokens.every(t => lower.includes(t));
			})
			.sort((a, b) => Number(b.startsWith('expenses:')) - Number(a.startsWith('expenses:')))
			.slice(0, 8);
	};

	const handleInput = (val: string) => {
		onChange(val);
		setSuggestions(filterAccounts(val));
	};

	return (
		<div className="autocomplete-wrap" style={{ marginBottom: 12 }}>
			<input
				ref={inputRef}
				type="text"
				className="env-inline-input"
				placeholder="e.g. expenses:food:groceries"
				value={value}
				autoComplete="off"
				autoCorrect="off"
				autoCapitalize="off"
				spellCheck={false}
				onChange={e => handleInput(e.target.value)}
				onFocus={e => e.target.select()}
				onBlur={() => setSuggestions([])}
				onKeyDown={e => {
					if (e.key === 'Enter') {
						setSuggestions([]);
						inputRef.current?.blur();
					}
				}}
			/>
			{suggestions.length > 0 && (
				<div className="autocomplete-list">
					{suggestions.map(s => (
						<div
							key={s}
							className="autocomplete-item"
							onPointerDown={e => {
								e.preventDefault();
								onChange(s);
								setSuggestions([]);
							}}
						>
							{s}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
