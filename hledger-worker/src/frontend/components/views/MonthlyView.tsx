import { useState, useMemo } from 'react';
import { extractAmount, fmtAmount, amountClass } from '../../utils/format';
import type { MonthlyData, Amount } from '../../types';

interface Props {
	data: MonthlyData | null;
	isActive: boolean;
}

export default function MonthlyView({ data, isActive }: Props) {
	const periodLabels = useMemo(() => {
		if (!data) return [];
		return (data.prDates || []).map(d => {
			const start = d[0]?.contents ?? '';
			if (!start) return '—';
			const dt = new Date(start + 'T00:00:00');
			return dt.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
		});
	}, [data]);

	const lastIdx = periodLabels.length - 1;
	const [periodIdx, setPeriodIdx] = useState(lastIdx < 0 ? 0 : lastIdx);

	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-monthly">
			{!data ? (
				<div className="state-msg">Tap sync to load data.</div>
			) : (
				<>
					<div className="month-select-row">
						<select
							className="month-select"
							value={periodIdx}
							onChange={e => setPeriodIdx(parseInt(e.target.value))}
						>
							{[...periodLabels].reverse().map((label, revIdx) => {
								const idx = periodLabels.length - 1 - revIdx;
								return (
									<option key={idx} value={idx}>{label}</option>
								);
							})}
						</select>
					</div>
					<MonthlyTable data={data} periodIdx={periodIdx} />
					<div className="view-footer">
						Data shown via <code>hledger balance --monthly</code>.
					</div>
				</>
			)}
		</div>
	);
}

function MonthlyTable({ data, periodIdx }: { data: MonthlyData; periodIdx: number }) {
	const amountMap: Record<string, Amount[]> = {};
	data.prRows.forEach(row => {
		const amts = row.prrAmounts?.[periodIdx] ?? [];
		if (amts.length > 0) {
			const { val } = extractAmount(amts);
			if (val !== 0) amountMap[row.prrName] = amts;
		}
	});

	if (Object.keys(amountMap).length === 0) {
		return <div className="state-msg">No activity this month.</div>;
	}

	const allNames = new Set<string>();
	Object.keys(amountMap).forEach(name => {
		const parts = name.split(':');
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
						const { val, commodity } = extractAmount(amounts);
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
		</>
	);
}
