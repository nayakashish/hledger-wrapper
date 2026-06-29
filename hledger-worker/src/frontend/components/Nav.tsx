import type { ViewName } from '../types';

interface Props {
	activeView: ViewName;
	onViewChange: (v: ViewName) => void;
}

const VIEWS: { id: ViewName; label: string }[] = [
	{ id: 'balance', label: 'Balance' },
	{ id: 'envelopes', label: 'Envelopes' },
	{ id: 'monthly', label: 'Monthly' },
	{ id: 'transactions', label: 'Transactions' },
];

export default function Nav({ activeView, onViewChange }: Props) {
	return (
		<nav>
			{VIEWS.map(v => (
				<button
					key={v.id}
					className={activeView === v.id ? 'active' : ''}
					onClick={() => onViewChange(v.id)}
				>
					{v.label}
				</button>
			))}
		</nav>
	);
}
