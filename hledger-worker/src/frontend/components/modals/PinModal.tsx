import { useState } from 'react';

interface Props {
	onClose: () => void;
	onSuccess: () => void;
}

export default function PinModal({ onClose, onSuccess }: Props) {
	const [pin, setPin] = useState('');
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState('');
	const [errorDots, setErrorDots] = useState(false);

	const handleKey = (digit: string) => {
		if (pin.length >= 4 || checking) return;
		const next = pin + digit;
		setPin(next);
		setError('');
		if (next.length === 4) {
			setTimeout(() => void checkPin(next), 80);
		}
	};

	const handleDelete = () => {
		if (checking) return;
		setPin(p => p.slice(0, -1));
		setError('');
	};

	const checkPin = async (value: string) => {
		setChecking(true);
		try {
			const r = await fetch('/api/demo/verify-pin', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pin: value }),
			});
			const data = await r.json() as { ok: boolean };
			if (data.ok) {
				onClose();
				onSuccess();
			} else {
				setErrorDots(true);
				setError('Incorrect PIN');
				setTimeout(() => {
					setPin('');
					setChecking(false);
					setError('');
					setErrorDots(false);
				}, 900);
			}
		} catch {
			setError('Network error — try again');
			setPin('');
			setChecking(false);
		}
	};

	return (
		<div className="pin-modal-overlay">
			<div className="pin-modal">
				<div className="pin-modal-title">Exit demo mode</div>
				<div className="pin-modal-sub">Enter your PIN to return to your data</div>
				<div className="pin-dots">
					{[0, 1, 2, 3].map(i => (
						<div
							key={i}
							className={`pin-dot${i < pin.length ? (errorDots ? ' error' : ' filled') : ''}`}
						/>
					))}
				</div>
				<div className="pin-error-msg">{error}</div>
				<div className="pin-keypad">
					{['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
						<button key={d} className="pin-key" onClick={() => handleKey(d)}>{d}</button>
					))}
					<button className="pin-key cancel" onClick={onClose}>Cancel</button>
					<button className="pin-key" onClick={() => handleKey('0')}>0</button>
					<button className="pin-key delete" onClick={handleDelete}>⌫</button>
				</div>
			</div>
		</div>
	);
}
