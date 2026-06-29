import { useState, useEffect, useCallback } from 'react';
import {
	BarChart, Bar, LineChart, Line,
	XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { extractAmount } from '../../utils/format';
import { usePrivacy } from '../../context/PrivacyContext';
import type { DailyTotal, MonthlyData } from '../../types';

interface Props {
	isActive: boolean;
	monthly: MonthlyData | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function last12Months(): string[] {
	const months: string[] = [];
	const now = new Date();
	for (let i = 11; i >= 0; i--) {
		const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
		months.push(d.toISOString().slice(0, 7));
	}
	return months;
}

function shortMonth(ym: string): string {
	const d = new Date(ym + '-01T00:00:00');
	return d.toLocaleDateString('en-CA', { month: 'short' });
}

function fmtK(v: number): string {
	if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
	return String(Math.round(v));
}

// ── Monthly chart data from existing endpoint ─────────────────────────────────

function buildMonthlyChartData(monthly: MonthlyData | null) {
	const months = last12Months();
	const income: Record<string, number> = {};
	const expenses: Record<string, number> = {};

	if (monthly) {
		monthly.prRows.forEach(row => {
			const name = row.prrName;
			const isIncome = name.startsWith('income');
			const isExpense = name.startsWith('expenses');
			if (!isIncome && !isExpense) return;

			monthly.prDates.forEach((dateRange, idx) => {
				const ym = dateRange[0]?.contents?.slice(0, 7) ?? '';
				if (!months.includes(ym)) return;
				const amts = row.prrAmounts?.[idx] ?? [];
				const { val } = extractAmount(amts);
				if (isIncome) income[ym] = (income[ym] ?? 0) + Math.abs(val);
				if (isExpense) expenses[ym] = (expenses[ym] ?? 0) + Math.abs(val);
			});
		});
	}

	return months.map(ym => ({
		month: shortMonth(ym),
		ym,
		income: income[ym] ?? 0,
		expenses: expenses[ym] ?? 0,
		net: (income[ym] ?? 0) - (expenses[ym] ?? 0),
	}));
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

function Heatmap({ data }: { data: DailyTotal[] }) {
	const byDate = new Map(data.map(d => [d.date, d]));

	const today = new Date();
	const days: { date: string; val: number }[] = [];
	for (let i = 364; i >= 0; i--) {
		const d = new Date(today);
		d.setDate(d.getDate() - i);
		const ds = d.toISOString().slice(0, 10);
		const entry = byDate.get(ds);
		days.push({ date: ds, val: entry ? entry.count : 0 });
	}

	const maxVal = Math.max(1, ...days.map(d => d.val));

	const intensity = (v: number) => {
		if (v === 0) return 0;
		return Math.ceil((v / maxVal) * 4);
	};

	// Group into weeks (columns)
	const firstDow = new Date(days[0].date + 'T00:00:00').getDay();
	const paddedDays = [...Array(firstDow).fill(null), ...days];
	const weeks: (typeof days[0] | null)[][] = [];
	for (let i = 0; i < paddedDays.length; i += 7) {
		weeks.push(paddedDays.slice(i, i + 7));
	}

	return (
		<div className="heatmap-wrap">
			<div className="heatmap-grid">
				{weeks.map((week, wi) => (
					<div key={wi} className="heatmap-col">
						{week.map((day, di) => (
							<div
								key={di}
								className={`heatmap-cell level-${day ? intensity(day.val) : 'empty'}`}
								title={day ? `${day.date}: ${day.val} txn${day.val !== 1 ? 's' : ''}` : ''}
							/>
						))}
					</div>
				))}
			</div>
		</div>
	);
}

// ── Spending comparison toggle ────────────────────────────────────────────────

type CompareMode = 'last-month' | 'rolling-avg';

function SpendingChart({
	chartData,
	privacyMode,
}: {
	chartData: ReturnType<typeof buildMonthlyChartData>;
	privacyMode: boolean;
}) {
	const [mode, setMode] = useState<CompareMode>('last-month');
	const lastMonth = chartData[chartData.length - 2];
	const thisMonth = chartData[chartData.length - 1];

	const rollingAvg = chartData.slice(0, -1).reduce((s, d) => s + d.expenses, 0) /
		Math.max(1, chartData.length - 1);

	const compareVal = mode === 'last-month'
		? (lastMonth?.expenses ?? 0)
		: rollingAvg;
	const compareLabel = mode === 'last-month' ? 'Last month' : '3-mo avg';

	const data = [
		{ label: compareLabel, expenses: privacyMode ? 0 : compareVal },
		{ label: thisMonth?.month ?? 'This month', expenses: privacyMode ? 0 : (thisMonth?.expenses ?? 0) },
	];

	return (
		<div className="dash-chart-card">
			<div className="dash-chart-header">
				<span className="dash-chart-title">Spending vs Prior</span>
				<div className="dash-compare-toggle">
					<button
						className={mode === 'last-month' ? 'active' : ''}
						onClick={() => setMode('last-month')}
					>Last mo</button>
					<button
						className={mode === 'rolling-avg' ? 'active' : ''}
						onClick={() => setMode('rolling-avg')}
					>3-mo avg</button>
				</div>
			</div>
			{privacyMode ? (
				<div className="dash-privacy-blur">
					<span>Hidden</span>
				</div>
			) : (
				<ResponsiveContainer width="100%" height={140}>
					<BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
						<XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
						<YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={36} />
						<Tooltip formatter={(v) => [`$${Number(v).toFixed(2)}`, 'Spending']} labelStyle={{ fontSize: 11 }} contentStyle={{ fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }} />
						<Bar dataKey="expenses" fill="var(--negative)" radius={[4, 4, 0, 0]} />
					</BarChart>
				</ResponsiveContainer>
			)}
		</div>
	);
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function DashboardView({ isActive, monthly }: Props) {
	const { privacyMode } = usePrivacy();
	const [dailyTotals, setDailyTotals] = useState<DailyTotal[] | null>(null);
	const [dailyError, setDailyError] = useState(false);

	const fetchDailyTotals = useCallback(async () => {
		try {
			const r = await fetch('/api/daily-totals');
			if (!r.ok) { setDailyError(true); return; }
			const json = await r.json() as DailyTotal[];
			setDailyTotals(json);
		} catch {
			setDailyError(true);
		}
	}, []);

	useEffect(() => {
		if (isActive && !dailyTotals && !dailyError) void fetchDailyTotals();
	}, [isActive, dailyTotals, dailyError, fetchDailyTotals]);

	const chartData = buildMonthlyChartData(monthly);

	// Net worth over time: cumulative income - expenses
	const netWorthData = chartData.map((d, i) => {
		const cumNet = chartData.slice(0, i + 1).reduce((s, x) => s + x.net, 0);
		return { month: d.month, netWorth: privacyMode ? 0 : cumNet };
	});

	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-dashboard">
			{/* Heatmap */}
			<div className="dash-section-title">Activity — trailing 12 months</div>
			{dailyError ? (
				<div className="state-msg" style={{ fontSize: 12 }}>
					Heatmap requires <code>/api/daily-totals</code> endpoint.
				</div>
			) : !dailyTotals ? (
				<div className="state-msg" style={{ fontSize: 12 }}>Loading heatmap…</div>
			) : (
				<Heatmap data={dailyTotals} />
			)}

			{!monthly ? (
				<div className="state-msg">Tap sync to load chart data.</div>
			) : (
				<>
					{/* Profit / Loss */}
					<div className="dash-chart-card">
						<div className="dash-chart-header">
							<span className="dash-chart-title">Profit / Loss</span>
						</div>
						{privacyMode ? (
							<div className="dash-privacy-blur"><span>Hidden</span></div>
						) : (
							<ResponsiveContainer width="100%" height={140}>
								<BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
									<XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
									<YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={36} />
									<Tooltip formatter={(v) => [`$${Number(v).toFixed(2)}`, '']} labelStyle={{ fontSize: 11 }} contentStyle={{ fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }} />
									<ReferenceLine y={0} stroke="var(--border)" />
									<Bar dataKey="net" radius={[4, 4, 0, 0]}
										fill="var(--positive)"
										label={false}
										// negative bars: recharts doesn't support per-bar color without Cell
									/>
								</BarChart>
							</ResponsiveContainer>
						)}
					</div>

					{/* Spending vs prior */}
					<SpendingChart chartData={chartData} privacyMode={privacyMode} />

					{/* Net Worth Over Time */}
					<div className="dash-chart-card">
						<div className="dash-chart-header">
							<span className="dash-chart-title">Net Worth Over Time</span>
						</div>
						{privacyMode ? (
							<div className="dash-privacy-blur"><span>Hidden</span></div>
						) : (
							<ResponsiveContainer width="100%" height={140}>
								<LineChart data={netWorthData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
									<XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
									<YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={36} />
									<Tooltip formatter={(v) => [`$${Number(v).toFixed(2)}`, 'Net Worth']} labelStyle={{ fontSize: 11 }} contentStyle={{ fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }} />
									<ReferenceLine y={0} stroke="var(--border)" />
									<Line dataKey="netWorth" stroke="var(--accent)" strokeWidth={2} dot={false} />
								</LineChart>
							</ResponsiveContainer>
						)}
					</div>
				</>
			)}
		</div>
	);
}
