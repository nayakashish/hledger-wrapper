import { useState, useEffect, useMemo, useRef } from 'react';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { ChevronLeftIcon, CloseIcon } from '../Icons';
import EntryPreview from '../EntryPreview';
import type { AddFormState, PredictedPosting, Preset } from '../../types';

// The free-form flow, unchanged: what every entry used to walk through.
const STANDARD_STEPS = ['date', 'description', 'account1', 'amount1', 'account2', 'amount2', 'preview'] as const;

type Step = 'preset' | 'party' | typeof STANDARD_STEPS[number];

const STEP_TITLES: Record<Step, string> = {
	preset: 'Add',
	date: 'Date',
	party: 'Who',
	description: 'Description',
	account1: 'Account 1',
	amount1: 'Amount',
	account2: 'Account 2',
	amount2: 'Amount 2',
	preview: 'Preview',
};

/**
 * The steps a preset walks. A preset's debit side is `account1` and its credit
 * side `account2`, which is the order the form already stores them in — so a
 * preset only prefills and skips, it never reshapes the entry.
 *
 * This vocabulary is deliberately closed. A preset that wants a step of its
 * own is a design decision, not a patch: one bespoke step type per preset is
 * how this component turns back into the pile of conditionals the fixed
 * seven-step constant was better than.
 */
function stepsFor(preset: Preset | null): Step[] {
	if (!preset || preset.free_form) return ['preset', ...STANDARD_STEPS];
	return [
		'preset',
		'date',
		...(preset.asks_party ? ['party' as Step] : []),
		...(preset.debit?.pick ? ['account1' as Step] : []),
		...(preset.credit?.pick ? ['account2' as Step] : []),
		'amount1',
		'preview',
	];
}

/** Fill a preset's title template, e.g. "e-transfer to {name}". */
function fillTitle(title: string | undefined, party: string): string {
	return (title ?? '').replace('{name}', party.trim());
}

interface Props {
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => Promise<void>;
	accountsList: string[];
	descriptionsList: string[];
	presets: Preset[];
	showToast: (msg: string, duration?: number) => void;
}

export default function AddSheet({
	isOpen,
	onClose,
	onSuccess,
	accountsList,
	descriptionsList,
	presets,
	showToast,
}: Props) {
	const [stepIdx, setStepIdx] = useState(0);
	const [preset, setPreset] = useState<Preset | null>(null);
	const [form, setForm] = useState<AddFormState>({});
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState('');

	useBodyScrollLock(isOpen);

	useEffect(() => {
		if (isOpen) {
			setStepIdx(0);
			setPreset(null);
			setForm({});
			setSubmitting(false);
			setSubmitError('');
		}
	}, [isOpen]);

	if (!isOpen) return null;

	const steps = stepsFor(preset);
	const step = steps[stepIdx];
	const progress = ((stepIdx + 1) / steps.length) * 100;

	// An account step borrows its title from the preset's own wording, so a
	// transfer says "To"/"From" rather than "Account 1"/"Account 2".
	const title =
		step === 'account1' && preset?.debit ? preset.debit.label :
		step === 'account2' && preset?.credit ? preset.credit.label :
		STEP_TITLES[step];

	const goBack = () => {
		if (stepIdx === 0) { onClose(); return; }
		setStepIdx(i => i - 1);
	};

	const goNext = () => setStepIdx(i => i + 1);

	const updateForm = (patch: Partial<AddFormState>) =>
		setForm(prev => ({ ...prev, ...patch }));

	const choosePreset = (picked: Preset) => {
		setPreset(picked);
		setForm(picked.free_form ? {} : {
			_preset: picked.id,
			description: picked.title ?? '',
			account1: picked.debit?.account ?? '',
			account2: picked.credit?.account ?? '',
		});
		setStepIdx(1);
	};

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
						aria-label="Back"
					>
						<ChevronLeftIcon />
					</button>
					<span className="add-title">{title}</span>
					<button className="add-close" onClick={onClose} aria-label="Close">
						<CloseIcon />
					</button>
				</div>
				<div className="add-progress">
					<div className="add-progress-bar" style={{ width: `${progress}%` }} />
				</div>
				<div className="add-body">
					{submitError && <div className="error-msg">{submitError}</div>}
					{step === 'preset' && (
						<PresetStep presets={presets} onPick={choosePreset} />
					)}
					{step === 'party' && (
						<PartyStep
							label={preset?.id === 'receive-etransfer' ? 'Who sent it?' : 'Who is it going to?'}
							value={form.party}
							onNext={party => {
								updateForm({ party, description: fillTitle(preset?.title, party) });
								goNext();
							}}
						/>
					)}
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
							label={
								step === 'account1'
									? (preset?.debit?.label ?? 'Account 1')
									: (preset?.credit?.label ?? 'Account 2')
							}
							filter={step === 'account1' ? preset?.debit?.prefixes : preset?.credit?.prefixes}
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

// ── Step: Preset picker ───────────────────────────────────────────────────────

/** The resolved accounts, for the muted line under a preset's name. Only the
 * sides the journal actually answered for — a side you pick every time has
 * nothing useful to show here. */
function resolvedAccounts(preset: Preset): string {
	return [preset.debit, preset.credit]
		.filter(leg => leg && !leg.pick && leg.account)
		.map(leg => leg!.account)
		.join('  ·  ');
}

function PresetStep({
	presets,
	onPick,
}: {
	presets: Preset[];
	onPick: (p: Preset) => void;
}) {
	if (presets.length === 0) {
		// The catalog is fixed server-side and always has entries, so an empty
		// list means /api/presets did not answer — say so rather than looking
		// like a journal with nothing in it, and fall through to the flow that
		// needs no prefill at all.
		return (
			<>
				<div className="step-label">What kind of transaction?</div>
				<div className="step-options">
					<button
						className="step-option primary"
						onClick={() => onPick({ id: 'standard', label: 'Something else…', free_form: true, primary: true })}
					>
						Enter it manually
					</button>
				</div>
				<div className="step-hint">
					Presets need <code>/api/presets</code>, which did not respond.
				</div>
			</>
		);
	}

	return (
		<>
			<div className="step-label">What kind of transaction?</div>
			<div className="step-options">
				{presets.map(p => {
					const accounts = p.free_form ? '' : resolvedAccounts(p);
					return (
						<button
							key={p.id}
							className={`step-option${p.primary ? ' primary' : ''}`}
							onClick={() => onPick(p)}
						>
							{p.label}
							{accounts && <span className="preset-accounts">{accounts}</span>}
						</button>
					);
				})}
			</div>
		</>
	);
}

// ── Step: Party (the other person, for e-transfers) ───────────────────────────

function PartyStep({
	label,
	value,
	onNext,
}: {
	label: string;
	value?: string;
	onNext: (party: string) => void;
}) {
	const [text, setText] = useState(value || '');
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setTimeout(() => inputRef.current?.focus(), 50);
	}, []);

	const advance = () => { if (text.trim()) onNext(text.trim()); };

	return (
		<>
			<div className="step-label">{label}</div>
			<input
				ref={inputRef}
				type="text"
				className="step-input"
				placeholder="Name"
				value={text}
				autoComplete="off"
				autoCorrect="off"
				spellCheck={false}
				onChange={e => setText(e.target.value)}
				onKeyDown={e => { if (e.key === 'Enter') advance(); }}
			/>
			<button className="step-next" disabled={!text.trim()} onClick={advance}>
				Continue
			</button>
		</>
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
	label,
	filter,
	value,
	accountsList,
	onChange,
	onNext,
}: {
	label: string;
	/** "|"-separated account prefixes from the preset; unset means all accounts. */
	filter?: string;
	value: string;
	accountsList: string[];
	onChange: (v: string) => void;
	onNext: (v: string) => void;
}) {
	const [text, setText] = useState(value || '');
	const inputRef = useRef<HTMLInputElement>(null);

	// A preset narrows the list to its own prefixes, so "Category" offers
	// expense accounts and nothing else.
	const candidates = useMemo(() => {
		if (!filter) return accountsList;
		const prefixes = filter.split('|').filter(Boolean);
		return accountsList.filter(a => prefixes.some(pre => a.startsWith(pre)));
	}, [accountsList, filter]);

	// With a filter, the choices are worth showing before you type — that is
	// what makes a picked leg one tap instead of a typing exercise.
	const initial = filter ? candidates.slice(0, 8) : [];
	const [suggestions, setSuggestions] = useState<string[]>(initial);

	useEffect(() => {
		setTimeout(() => inputRef.current?.focus(), 50);
	}, []);

	const handleInput = (val: string) => {
		setText(val);
		onChange(val);
		if (!val.trim()) { setSuggestions(filter ? candidates.slice(0, 8) : []); return; }
		const q = val.toLowerCase();
		setSuggestions(candidates.filter(a => a.toLowerCase().includes(q)).slice(0, 8));
	};

	const selectSuggestion = (s: string) => {
		setText(s);
		onChange(s);
		setSuggestions([]);
	};

	return (
		<>
			<div className="step-label">{label}</div>
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
						aria-label="Clear"
						onPointerDown={e => { e.preventDefault(); setText(''); onChange(''); setSuggestions([]); inputRef.current?.focus(); }}
					>
						<CloseIcon size={14} />
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
			<EntryPreview value={text} onChange={setText} />
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
