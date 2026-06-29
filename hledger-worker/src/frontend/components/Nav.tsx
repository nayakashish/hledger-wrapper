import type { ViewName } from '../types';

interface Props {
	activeView: ViewName;
	onViewChange: (v: ViewName) => void;
}

const VIEWS: { id: ViewName; label: string }[] = [
	{ id: 'dashboard', label: 'Dashboard' },
	{ id: 'envelopes', label: 'Envelopes' },
	{ id: 'transactions', label: 'Transactions' },
	{ id: 'reports', label: 'Reports' },
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
