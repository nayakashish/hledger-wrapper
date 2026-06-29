import { useState, useEffect, useRef } from 'react';
import type { AddFormState, PredictedPosting } from '../../types';

const STEPS = ['date', 'description', 'account1', 'amount1', 'account2', 'amount2', 'preview'] as const;
type Step = typeof STEPS[number];

const STEP_TITLES: Record<Step, string> = {
	date: 'Date',
	description: 'Description',
	account1: 'Account 1',
	amount1: 'Amount',
	account2: 'Account 2',
	amount2: 'Amount 2',
	preview: 'Preview',
};

interface Props {
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => Promise<void>;
	accountsList: string[];
	descriptionsList: string[];
	showToast: (msg: string, duration?: number) => void;
}

export default function AddSheet({
	isOpen,
	onClose,
	onSuccess,
	accountsList,
	descriptionsList,
	showToast,
}: Props) {
	const [stepIdx, setStepIdx] = useState(0);
	const [form, setForm] = useState<AddFormState>({});
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState('');

	useEffect(() => {
		if (isOpen) {
			setStepIdx(0);
			setForm({});
			setSubmitting(false);
			setSubmitError('');
			document.body.style.overflow = 'hidden';
		} else {
			document.body.style.overflow = '';
		}
	}, [isOpen]);

	if (!isOpen) return null;

	const step = STEPS[stepIdx];
	const progress = ((stepIdx + 1) / STEPS.length) * 100;

	const goBack = () => {
		if (stepIdx === 0) { onClose(); return; }
		setStepIdx(i => i - 1);
	};

	const goNext = () => setStepIdx(i => i + 1);

	const updateForm = (patch: Partial<AddFormState>) =>
		setForm(prev => ({ ...prev, ...patch }));

	const handleSubmit = async (rawEntry: string) => {
		setSubmitting(true);
		setSubmitError('');
		try {
			const r = await fetch('/api/add', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ raw_entry: rawEntry }),
			});
			if (!r.ok) {
				const err = await r.json() as { detail?: string };
				throw new Error(err.detail || String(r.status));
			}
			onClose();
			await onSuccess();
		} catch (e) {
			setSubmitError('Failed to save: ' + (e instanceof Error ? e.message : String(e)));
			setSubmitting(false);
		}
	};

	return (
		<div className="add-sheet">
			<div className="add-sheet-inner">
				<div className="add-header">
					<button
						className="add-back"
						style={{ visibility: stepIdx === 0 ? 'hidden' : 'visible' }}
						onClick={goBack}
					>
						←
					</button>
					<span className="add-title">{STEP_TITLES[step]}</span>
					<button className="add-close" onClick={onClose}>✕</button>
				</div>
				<div className="add-progress">
					<div className="add-progress-bar" style={{ width: `${progress}%` }} />
				</div>
				<div className="add-body">
					{submitError && <div className="error-msg">{submitError}</div>}
					{step === 'date' && (
						<DateStep
							value={form.date}
							onChange={date => updateForm({ date })}
							onNext={goNext}
						/>
					)}
					{step === 'description' && (
						<DescriptionStep
							value={form.description}
							descriptionsList={descriptionsList}
							onChange={description => updateForm({ description })}
							onNext={async desc => {
								updateForm({ description: desc });
								let predicted: PredictedPosting | null = null;
								try {
									const r = await fetch('/api/lookup?description=' + encodeURIComponent(desc));
									if (r.ok) {
										const j = await r.json() as { match?: PredictedPosting };
										predicted = j.match || null;
									}
								} catch { /* ignore */ }
								updateForm({ _predicted: predicted, _amount2edited: false });
								goNext();
							}}
						/>
					)}
					{(step === 'account1' || step === 'account2') && (
						<AccountStep
							key={step}
							which={step === 'account1' ? 1 : 2}
							value={form[step] ?? (form._predicted?.[step] ?? '')}
							accountsList={accountsList}
							onChange={val => updateForm({ [step]: val })}
							onNext={val => {
								updateForm({ [step]: val });
								goNext();
							}}
						/>
					)}
					{(step === 'amount1' || step === 'amount2') && (
						<AmountStep
							key={step}
							label={step === 'amount1' ? 'How much?' : 'Offsetting amount'}
							hint={step === 'amount2' ? 'Defaults to inverse of amount 1. Edit if needed.' : ''}
							defaultValue={
								step === 'amount2'
									? (form._amount2edited ? form.amount2 : (form.amount1 !== undefined ? -form.amount1 : undefined))
									: form.amount1
							}
							onNext={val => {
								updateForm({
									[step]: val,
									...(step === 'amount2' ? { _amount2edited: true } : {}),
								});
								goNext();
							}}
						/>
					)}
					{step === 'preview' && (
						<PreviewStep
							form={form}
							submitting={submitting}
							onSubmit={handleSubmit}
							onBack={goBack}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

// ── Step: Date ────────────────────────────────────────────────────────────────

function DateStep({
	value,
	onChange,
	onNext,
}: {
	value?: string;
	onChange: (d: string) => void;
	onNext: () => void;
}) {
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	const fmt = (d: Date) => d.toISOString().slice(0, 10);
	const fmtLabel = (d: Date) =>
		d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });

	const [selected, setSelected] = useState(value || fmt(today));
	const [showPicker, setShowPicker] = useState(false);

	const select = (d: string) => { setSelected(d); onChange(d); };

	return (
		<>
			<div className="step-label">Select a date</div>
			<div className="step-options">
				<button
					className={`step-option${selected === fmt(today) ? ' selected' : ''}`}
					onClick={() => { select(fmt(today)); setShowPicker(false); }}
				>
					Today &nbsp;
					<span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{fmtLabel(today)}</span>
				</button>
				<button
					className={`step-option${selected === fmt(yesterday) ? ' selected' : ''}`}
					onClick={() => { select(fmt(yesterday)); setShowPicker(false); }}
				>
					Yesterday &nbsp;
					<span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{fmtLabel(yesterday)}</span>
				</button>
				<button
					className={`step-option${showPicker ? ' selected' : ''}`}
					onClick={() => setShowPicker(true)}
				>
					{showPicker ? selected : 'Pick a date…'}
				</button>
			</div>
			{showPicker && (
				<input
					type="date"
					className="step-input"
					value={selected}
					onChange={e => select(e.target.value)}
					autoFocus
				/>
			)}
			<button className="step-next" onClick={() => { onChange(selected); onNext(); }}>
				Continue
			</button>
		</>
	);
}

// ── Step: Description ─────────────────────────────────────────────────────────

function DescriptionStep({
	value,
	descriptionsList,
	onChange,
	onNext,
}: {
	value?: string;
	descriptionsList: string[];
	onChange: (d: string) => void;
	onNext: (desc: string) => Promise<void>;
}) {
	const [text, setText] = useState(value || '');
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setTimeout(() => inputRef.current?.focus(), 50);
	}, []);

	const handleInput = (val: string) => {
		setText(val);
		onChange(val);
		if (!val.trim() || descriptionsList.length === 0) { setSuggestions([]); return; }
		const q = val.toLowerCase();
		setSuggestions(descriptionsList.filter(d => d.toLowerCase().includes(q)).slice(0, 8));
	};

	const advance = async (desc: string) => {
		if (!desc.trim()) return;
		setLoading(true);
		await onNext(desc.trim());
		setLoading(false);
	};

	return (
		<>
			<div className="step-label">What was this for?</div>
			<div className="autocomplete-wrap">
				<input
					ref={inputRef}
					type="text"
					className="step-input"
					placeholder="e.g. Groceries, Rent, Salary"
					value={text}
					onChange={e => handleInput(e.target.value)}
					onKeyDown={e => { if (e.key === 'Enter' && text.trim()) void advance(text); }}
				/>
				{suggestions.length > 0 && (
					<div className="autocomplete-list">
						{suggestions.map(s => (
							<div
								key={s}
								className="autocomplete-item"
								onPointerDown={e => { e.preventDefault(); setText(s); setSuggestions([]); onChange(s); }}
							>
								{s}
							</div>
						))}
					</div>
				)}
			</div>
			<button
				className="step-next"
				disabled={!text.trim() || loading}
				onClick={() => void advance(text)}
			>
				{loading ? 'Looking up...' : 'Continue'}
			</button>
		</>
	);
}

// ── Step: Account ─────────────────────────────────────────────────────────────

function AccountStep({
	which,
	value,
	accountsList,
	onChange,
	onNext,
}: {
	which: 1 | 2;
	value: string;
	accountsList: string[];
	onChange: (v: string) => void;
	onNext: (v: string) => void;
}) {
	const [text, setText] = useState(value || '');
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setTimeout(() => inputRef.current?.focus(), 50);
	}, []);

	const handleInput = (val: string) => {
		setText(val);
		onChange(val);
		if (!val.trim() || accountsList.length === 0) { setSuggestions([]); return; }
		const q = val.toLowerCase();
		setSuggestions(accountsList.filter(a => a.toLowerCase().includes(q)).slice(0, 8));
	};

	const selectSuggestion = (s: string) => {
		setText(s);
		onChange(s);
		setSuggestions([]);
	};

	return (
		<>
			<div className="step-label">Account {which}</div>
			<div className="autocomplete-wrap">
				<input
					ref={inputRef}
					type="text"
					className="step-input"
					style={{ paddingRight: text ? 36 : 16 }}
					placeholder="e.g. expenses:food:groceries"
					value={text}
					autoComplete="off"
					autoCorrect="off"
					spellCheck={false}
					onChange={e => handleInput(e.target.value)}
					onKeyDown={e => {
						if (e.key === 'Enter' && text.trim()) { setSuggestions([]); onNext(text.trim()); }
					}}
				/>
				{text && (
					<button
						className="input-clear-btn"
						onPointerDown={e => { e.preventDefault(); setText(''); onChange(''); setSuggestions([]); inputRef.current?.focus(); }}
					>
						✕
					</button>
				)}
				{suggestions.length > 0 && (
					<div className="autocomplete-list">
						{suggestions.map(s => (
							<div
								key={s}
								className="autocomplete-item"
								onPointerDown={e => { e.preventDefault(); selectSuggestion(s); }}
							>
								{s}
							</div>
						))}
					</div>
				)}
			</div>
			<button
				className="step-next"
				disabled={!text.trim()}
				onClick={() => { if (text.trim()) { setSuggestions([]); onNext(text.trim()); } }}
			>
				Continue
			</button>
		</>
	);
}

// ── Step: Amount ──────────────────────────────────────────────────────────────

function AmountStep({
	label,
	hint,
	defaultValue,
	onNext,
}: {
	label: string;
	hint: string;
	defaultValue?: number;
	onNext: (val: number) => void;
}) {
	const [text, setText] = useState(defaultValue !== undefined ? String(defaultValue) : '');
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 50);
	}, []);

	const advance = () => {
		const val = parseFloat(text);
		if (!isNaN(val)) onNext(val);
	};

	return (
		<>
			<div className="step-label">{label}</div>
			<input
				ref={inputRef}
				type="number"
				className="step-input"
				placeholder="0.00"
				step="0.01"
				value={text}
				onChange={e => setText(e.target.value)}
				onKeyDown={e => { if (e.key === 'Enter') advance(); }}
			/>
			{hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>{hint}</div>}
			<button className="step-next" onClick={advance} disabled={isNaN(parseFloat(text))}>
				Continue
			</button>
		</>
	);
}

// ── Step: Preview ─────────────────────────────────────────────────────────────

function PreviewStep({
	form,
	submitting,
	onSubmit,
	onBack,
}: {
	form: AddFormState;
	submitting: boolean;
	onSubmit: (raw: string) => Promise<void>;
	onBack: () => void;
}) {
	const { date, description, account1, amount1, account2 } = form;
	const amount2 = form.amount2 !== undefined ? form.amount2 : (amount1 !== undefined ? -amount1 : 0);
	const currency = '$';
	const fmt = (n: number) => currency + Math.abs(n).toFixed(2);
	const sign = (n: number) => n < 0 ? '-' : '';

	const entryText =
		`${date || ''} ${description || ''}\n` +
		`    ${account1 || ''}    ${sign(amount1 ?? 0)}${fmt(amount1 ?? 0)}\n` +
		`    ${account2 || ''}    ${sign(amount2)}${fmt(amount2)}`;

	const [text, setText] = useState(entryText);

	return (
		<>
			<div className="step-label">Review entry</div>
			<div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 300 }}>
				Edit directly to add comments (use ; for inline comments)
			</div>
			<textarea
				className="preview-entry"
				rows={6}
				spellCheck={false}
				value={text}
				onChange={e => setText(e.target.value)}
			/>
			<button
				className="confirm-btn"
				disabled={submitting}
				onClick={() => void onSubmit(text)}
			>
				{submitting ? 'Saving...' : 'Confirm & Save'}
			</button>
			<button className="cancel-btn" onClick={onBack}>Go back & edit</button>
		</>
	);
}
