import { useState, useEffect, useCallback, useRef } from 'react';
import {
	BarChart, Bar, LineChart, Line,
	XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { extractAmount, fmtAmount, amountClass } from '../../utils/format';
import type { DailyTotal, MonthlyData, Transaction } from '../../types';

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

const DOW_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function Heatmap({
	data,
	onDayClick,
	selectedDay,
}: {
	data: DailyTotal[];
	onDayClick: (date: string) => void;
	selectedDay: string | null;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const byDate = new Map(data.map(d => [d.date, d]));

	const today = new Date();
	const startOfYear = new Date(today.getFullYear(), 0, 1);
	const days: { date: string; val: number }[] = [];
	for (let d = new Date(startOfYear); d <= today; d.setDate(d.getDate() + 1)) {
		const ds = d.toISOString().slice(0, 10);
		const entry = byDate.get(ds);
		days.push({ date: ds, val: entry ? entry.count : 0 });
	}

	const maxVal = Math.max(1, ...days.map(d => d.val));
	const intensity = (v: number) => {
		if (v === 0) return 0;
		return Math.ceil((v / maxVal) * 4);
	};

	const firstDow = new Date(days[0].date + 'T00:00:00').getDay();
	const paddedDays = [...Array(firstDow).fill(null), ...days];
	const weeks: (typeof days[0] | null)[][] = [];
	for (let i = 0; i < paddedDays.length; i += 7) {
		weeks.push(paddedDays.slice(i, i + 7));
	}

	// Month label: show abbreviation above first week that contains the 1st of a month
	const monthLabels: (string | null)[] = weeks.map(week => {
		const first = week.find(d => d && d.date.slice(8) === '01');
		if (!first) return null;
		return new Date(first.date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short' });
	});

	// Scroll to most recent (right edge) on mount
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
		}
	}, []);

	return (
		<div className="heatmap-outer">
			<div className="heatmap-dow-col">
				<div className="heatmap-month-spacer" />
				{DOW_LABELS.map((d, i) => (
					<div key={i} className="heatmap-dow-label">{d}</div>
				))}
			</div>
			<div className="heatmap-scroll" ref={scrollRef}>
				<div className="heatmap-months-row">
					{weeks.map((_, wi) => (
						<div key={wi} className="heatmap-month-cell">
							{monthLabels[wi] ?? ''}
						</div>
					))}
				</div>
				<div className="heatmap-grid">
					{weeks.map((week, wi) => (
						<div key={wi} className="heatmap-col">
							{week.map((day, di) => (
								<div
									key={di}
									className={`heatmap-cell level-${day ? intensity(day.val) : 'empty'}${day && day.date === selectedDay ? ' selected' : ''}`}
									title={day ? `${day.date}: ${day.val} txn${day.val !== 1 ? 's' : ''}` : ''}
									onClick={() => day && day.val > 0 && onDayClick(day.date)}
								/>
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

// ── Day detail panel ──────────────────────────────────────────────────────────

function DayDetail({
	date,
	txns,
	loading,
	onClose,
}: {
	date: string;
	txns: Transaction[];
	loading: boolean;
	onClose: () => void;
}) {
	const label = new Date(date + 'T00:00:00').toLocaleDateString('en-CA', {
		weekday: 'short', month: 'short', day: 'numeric',
	});

	return (
		<div className="day-detail">
			<div className="day-detail-header">
				<span className="day-detail-title">{label}</span>
				<button className="day-detail-close" onClick={onClose}>✕</button>
			</div>
			{loading ? (
				<div className="drilldown-loading">Loading…</div>
			) : txns.length === 0 ? (
				<div className="drilldown-loading">No transactions.</div>
			) : (
				txns.map((txn, i) => {
					const desc = txn.tdescription || txn.tpayee || '—';
					const postings = txn.tpostings || [];
					const { val, commodity } = extractAmount(postings[0]?.pamount);
					return (
						<div key={i} className="drilldown-txn">
							<div className="txn-top">
								<span className="txn-desc">{desc}</span>
								<span className={`txn-amount ${amountClass(val)}`}>
									{fmtAmount(val, commodity)}
								</span>
							</div>
							<div className="txn-meta">
								{postings.map(p => p.paccount).filter(Boolean).join(' · ')}
							</div>
						</div>
					);
				})
			)}
		</div>
	);
}

// ── Spending comparison toggle ────────────────────────────────────────────────

type CompareMode = 'last-month' | 'rolling-avg';

function SpendingChart({ chartData }: { chartData: ReturnType<typeof buildMonthlyChartData> }) {
	const [mode, setMode] = useState<CompareMode>('last-month');
	const lastMonth = chartData[chartData.length - 2];
	const thisMonth = chartData[chartData.length - 1];
	const rollingAvg = chartData.slice(0, -1).reduce((s, d) => s + d.expenses, 0) /
		Math.max(1, chartData.length - 1);
	const compareVal = mode === 'last-month' ? (lastMonth?.expenses ?? 0) : rollingAvg;
	const compareLabel = mode === 'last-month' ? 'Last month' : '3-mo avg';

	const data = [
		{ label: compareLabel, expenses: compareVal },
		{ label: thisMonth?.month ?? 'This month', expenses: thisMonth?.expenses ?? 0 },
	];

	return (
		<div className="dash-chart-card">
			<div className="dash-chart-header">
				<span className="dash-chart-title">Spending vs Prior</span>
				<div className="dash-compare-toggle">
					<button className={mode === 'last-month' ? 'active' : ''} onClick={() => setMode('last-month')}>Last mo</button>
					<button className={mode === 'rolling-avg' ? 'active' : ''} onClick={() => setMode('rolling-avg')}>3-mo avg</button>
				</div>
			</div>
			<ResponsiveContainer width="100%" height={140}>
				<BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
					<XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
					<YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={36} />
					<Tooltip formatter={(v) => [`$${Number(v).toFixed(2)}`, 'Spending']} labelStyle={{ fontSize: 11 }} contentStyle={{ fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }} />
					<Bar dataKey="expenses" fill="var(--negative)" radius={[4, 4, 0, 0]} />
				</BarChart>
			</ResponsiveContainer>
		</div>
	);
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function DashboardView({ isActive, monthly }: Props) {
	const [dailyTotals, setDailyTotals] = useState<DailyTotal[] | null>(null);
	const [dailyError, setDailyError] = useState(false);
	const [selectedDay, setSelectedDay] = useState<string | null>(null);
	const [txnsByMonth, setTxnsByMonth] = useState<Record<string, Transaction[]>>({});
	const [dayLoading, setDayLoading] = useState(false);

	const fetchDailyTotals = useCallback(async () => {
		try {
			const fromDate = `${new Date().getFullYear()}-01-01`;
			const r = await fetch(`/api/daily-totals?from_date=${fromDate}`);
			if (!r.ok) { setDailyError(true); return; }
			setDailyTotals(await r.json() as DailyTotal[]);
		} catch {
			setDailyError(true);
		}
	}, []);

	useEffect(() => {
		if (isActive && !dailyTotals && !dailyError) void fetchDailyTotals();
	}, [isActive, dailyTotals, dailyError, fetchDailyTotals]);

	const handleDayClick = useCallback(async (date: string) => {
		if (selectedDay === date) {
			setSelectedDay(null);
			return;
		}
		setSelectedDay(date);
		const ym = date.slice(0, 7);
		if (!txnsByMonth[ym]) {
			setDayLoading(true);
			try {
				const r = await fetch(`/api/transactions?month=${ym}`);
				if (!r.ok) throw new Error(String(r.status));
				const json = await r.json() as { raw: string };
				setTxnsByMonth(prev => ({ ...prev, [ym]: JSON.parse(json.raw) as Transaction[] }));
			} catch {
				setTxnsByMonth(prev => ({ ...prev, [ym]: [] }));
			} finally {
				setDayLoading(false);
			}
		}
	}, [selectedDay, txnsByMonth]);

	const dayTxns = selectedDay
		? (txnsByMonth[selectedDay.slice(0, 7)] ?? []).filter(t => t.tdate === selectedDay)
		: [];

	const chartData = buildMonthlyChartData(monthly);
	const netWorthData = chartData.map((d, i) => ({
		month: d.month,
		netWorth: chartData.slice(0, i + 1).reduce((s, x) => s + x.net, 0),
	}));

	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-dashboard">
			{/* Heatmap */}
			{dailyError ? (
				<div className="state-msg" style={{ fontSize: 12 }}>
					Heatmap requires <code>/api/daily-totals</code> endpoint.
				</div>
			) : !dailyTotals ? (
				<div className="state-msg" style={{ fontSize: 12 }}>Loading heatmap…</div>
			) : (
				<>
					<Heatmap data={dailyTotals} onDayClick={handleDayClick} selectedDay={selectedDay} />
					{selectedDay && (
						<DayDetail
							date={selectedDay}
							txns={dayTxns}
							loading={dayLoading && !txnsByMonth[selectedDay.slice(0, 7)]}
							onClose={() => setSelectedDay(null)}
						/>
					)}
				</>
			)}

			{!monthly ? (
				<div className="state-msg">Tap sync to load chart data.</div>
			) : (
				<>
					<div className="dash-chart-card">
						<div className="dash-chart-header">
							<span className="dash-chart-title">Profit / Loss</span>
						</div>
						<ResponsiveContainer width="100%" height={140}>
							<BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
								<XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
								<YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={36} />
								<Tooltip formatter={(v) => [`$${Number(v).toFixed(2)}`, '']} labelStyle={{ fontSize: 11 }} contentStyle={{ fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }} />
								<ReferenceLine y={0} stroke="var(--border)" />
								<Bar dataKey="net" fill="var(--positive)" radius={[4, 4, 0, 0]} />
							</BarChart>
						</ResponsiveContainer>
					</div>

					<SpendingChart chartData={chartData} />

					<div className="dash-chart-card">
						<div className="dash-chart-header">
							<span className="dash-chart-title">Net Worth Over Time</span>
						</div>
						<ResponsiveContainer width="100%" height={140}>
							<LineChart data={netWorthData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
								<XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
								<YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={36} />
								<Tooltip formatter={(v) => [`$${Number(v).toFixed(2)}`, 'Net Worth']} labelStyle={{ fontSize: 11 }} contentStyle={{ fontSize: 11, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }} />
								<ReferenceLine y={0} stroke="var(--border)" />
								<Line dataKey="netWorth" stroke="var(--accent)" strokeWidth={2} dot={false} />
							</LineChart>
						</ResponsiveContainer>
					</div>
				</>
			)}
		</div>
	);
}
