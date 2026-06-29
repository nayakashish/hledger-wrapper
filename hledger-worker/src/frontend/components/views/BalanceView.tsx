import { extractAmount, fmtAmount, amountClass } from '../../utils/format';
import type { BalanceRow } from '../../types';

interface Props {
	data: BalanceRow[][] | null;
	isActive: boolean;
}

export default function BalanceView({ data, isActive }: Props) {
	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-balance">
			{!data ? (
				<div className="state-msg">Tap sync to load data.</div>
			) : (
				<BalanceContent data={data} />
			)}
		</div>
	);
}

function BalanceContent({ data }: { data: BalanceRow[][] }) {
	const rows = Array.isArray(data[0]) ? data[0] : [];
	if (rows.length === 0) return <div className="state-msg">No data.</div>;

	const amountMap: Record<string, BalanceRow[3]> = {};
	rows.forEach(row => { amountMap[row[0]] = row[3]; });

	const allNames = new Set<string>();
	rows.forEach(row => {
		const parts = (row[0] as string).split(':');
		for (let i = 1; i <= parts.length; i++) allNames.add(parts.slice(0, i).join(':'));
	});

	const sorted = Array.from(allNames).sort();
	const groups: Record<string, string[]> = {};
	const groupOrder: string[] = [];
	sorted.forEach(name => {
		const top = name.split(':')[0];
		if (!groups[top]) { groups[top] = []; groupOrder.push(top); }
		if (name !== top) groups[top].push(name);
	});

	return (
		<>
			{groupOrder.map(group => (
				<div key={group}>
					<div className="section-title">{group}</div>
					{groups[group].map(fullName => {
						const depth = (fullName.match(/:/g) || []).length;
						const amounts = amountMap[fullName] || [];
						const { val, commodity } = extractAmount(amounts as Parameters<typeof extractAmount>[0]);
						const label = fullName.split(':').pop() || fullName;
						const indentPx = (depth - 1) * 16;
						const hasChildren = sorted.some(n => n !== fullName && n.startsWith(fullName + ':'));
						return (
							<div key={fullName} className="account-row">
								<span
									className="account-name"
									style={{
										paddingLeft: indentPx,
										...(hasChildren ? { fontWeight: 500, color: 'var(--accent)' } : {}),
									}}
								>
									{label}
								</span>
								<span className={`account-amount ${amountClass(val)}`}>
									{amounts.length > 0 ? fmtAmount(val, commodity) : ''}
								</span>
							</div>
						);
					})}
					<br />
				</div>
			))}
			<div className="view-footer">
				Data shown via <code>hledger balance</code>.
			</div>
		</>
	);
}
