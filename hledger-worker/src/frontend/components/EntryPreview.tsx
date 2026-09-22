import { useEffect, useRef } from 'react';

interface Props {
	value: string;
	onChange: (v: string) => void;
	/** Show generated text that the first tap hands over to the user. */
	locked?: boolean;
	/** Called by that first tap, before the box becomes editable. */
	onUnlock?: () => void;
	rows?: number;
}

/**
 * The journal-entry textarea shared by the add sheet and the inbox review.
 *
 * Both sheets show a generated entry and let you type over it, and they had
 * drifted: the add sheet's was always editable while the inbox's sat behind
 * `readOnly` and swallowed the first tap, because flipping the flag left
 * nothing focused — no cursor, no keyboard, an apparently dead tap.
 *
 * Unlocking and focusing therefore belong in one place. The focus happens in
 * an effect rather than the handler, since the box is still `readOnly` at tap
 * time and a `readOnly` textarea cannot take a cursor; `onPointerDown` keeps
 * it early enough in the gesture that iOS still counts it as user-initiated
 * and opens the keyboard.
 */
export default function EntryPreview({ value, onChange, locked = false, onUnlock, rows = 6 }: Props) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const wasLocked = useRef(locked);

	useEffect(() => {
		if (wasLocked.current && !locked && ref.current) {
			const el = ref.current;
			el.focus();
			// Caret at the end, never select-all: the next keystroke would
			// otherwise wipe the entry.
			el.setSelectionRange(el.value.length, el.value.length);
		}
		wasLocked.current = locked;
	}, [locked]);

	return (
		<textarea
			ref={ref}
			className="preview-entry"
			rows={rows}
			spellCheck={false}
			readOnly={locked}
			value={value}
			onChange={e => onChange(e.target.value)}
			onPointerDown={() => { if (locked) onUnlock?.(); }}
		/>
	);
}
