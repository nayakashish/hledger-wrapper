import { useState } from 'react';

interface Props {
	accounts: string[];
	isActive: boolean;
}

export default function CoAView({ accounts, isActive }: Props) {
	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-coa">
			{accounts.length === 0 ? (
				<div className="state-msg">Tap sync to load data.</div>
			) : (
				<CoAContent accounts={accounts} />
			)}
		</div>
	);
}

function CoAContent({ accounts }: { accounts: string[] }) {
	// accounts whose children are currently shown
	const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());

	// The CoA file declares leaves; synthesize every ancestor so the tree is complete
	const allNames = new Set<string>();
	accounts.forEach(name => {
		const parts = name.split(':');
		for (let i = 1; i <= parts.length; i++) allNames.add(parts.slice(0, i).join(':'));
	});
	const sorted = Array.from(allNames).sort();

	const hasChildren = (name: string) =>
		sorted.some(n => n !== name && n.startsWith(name + ':'));

	const parents = sorted.filter(hasChildren);
	const allExpanded = parents.every(p => expandedAccounts.has(p));

	// Visible if depth ≤ 1 (one colon), or every ancestor from depth 2 up is expanded
	const isVisible = (fullName: string) => {
		const parts = fullName.split(':');
		if (parts.length <= 2) return true;
		for (let i = 2; i < parts.length; i++) {
			if (!expandedAccounts.has(parts.slice(0, i).join(':'))) return false;
		}
		return true;
	};

	const toggle = (fullName: string) => {
		if (!hasChildren(fullName)) return;
		setExpandedAccounts(prev => {
			const next = new Set(prev);
			if (next.has(fullName)) {
				// collapse this node and all its expanded descendants
				for (const n of Array.from(next)) {
					if (n === fullName || n.startsWith(fullName + ':')) next.delete(n);
				}
			} else {
				next.add(fullName);
			}
			return next;
		});
	};

	const groups: Record<string, string[]> = {};
	const groupOrder: string[] = [];
	sorted.forEach(name => {
		const top = name.split(':')[0];
		if (!groups[top]) { groups[top] = []; groupOrder.push(top); }
		if (name !== top) groups[top].push(name);
	});

	return (
		<>
			<div className="coa-controls">
				<span className="coa-count">{accounts.length} accounts</span>
				<button
					className="coa-toggle-all"
					onClick={() =>
						setExpandedAccounts(allExpanded ? new Set() : new Set(parents))
					}
				>
					{allExpanded ? 'Collapse all' : 'Expand all'}
				</button>
			</div>
			{groupOrder.map(group => (
				<div key={group}>
					<div className="section-title">{group}</div>
					{groups[group].filter(isVisible).map(fullName => {
						const depth = (fullName.match(/:/g) || []).length;
						const label = fullName.split(':').pop() || fullName;
						const isParent = hasChildren(fullName);
						const isExpanded = expandedAccounts.has(fullName);
						return (
							<div
								key={fullName}
								className={`account-row${isParent ? ` drilldown-row${isExpanded ? ' expanded' : ''}` : ''}`}
								onClick={() => toggle(fullName)}
							>
								<span
									className="account-name"
									style={{
										paddingLeft: (depth - 1) * 16,
										...(isParent ? { fontWeight: 500, color: 'var(--accent)' } : {}),
									}}
								>
									{label}
								</span>
								{isParent && (
									<span className="coa-chevron">{isExpanded ? '−' : '+'}</span>
								)}
							</div>
						);
					})}
					<br />
				</div>
			))}
			<div className="view-footer">
				Chart of accounts via <code>hledger accounts --declared</code>. Tap a parent account to expand or collapse it.
			</div>
		</>
	);
}
