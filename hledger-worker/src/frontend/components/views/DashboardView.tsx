import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
	BarChart, Bar,
	XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { extractAmount, fmtAmount, amountClass } from '../../utils/format';
import { usePrivacy } from '../../context/PrivacyContext';
import { loadRawEndpoint } from '../../utils/api';
import MaskedAmount from '../MaskedAmount';
import VerseCard from '../VerseCard';
import type { DailyTotal, MonthlyData, Transaction } from '../../types';

interface Props {
	isActive: boolean;
	monthly: MonthlyData | null;
	syncKey: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TEAL = '#2a938c';
const CORAL = '#c0392b';

const TEAL_PALETTE = ['#1a6560', '#2a938c', '#3aada6', '#5db8b2', '#84ccc8', '#b8dbd9'];

const TOOLTIP_STYLE = {
	fontSize: 11,
	background: 'var(--surface)',
	border: '1px solid var(--border)',
	borderRadius: 6,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function ytdMonths(): string[] {
	const months: string[] = [];
	const now = new Date();
	for (let m = 0; m <= now.getMonth(); m++) {
		months.push(`${now.getFullYear()}-${String(m + 1).padStart(2, '0')}`);
	}
	return months;
}

function shortMonth(ym: string): string {
	return new Date(ym + '-01T00:00:00').toLocaleDateString('en-CA', { month: 'short' });
}

function fmtK(v: number): string {
	if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
	return String(Math.round(v));
}

// ── Chart data builder ────────────────────────────────────────────────────────

interface ChartPoint {
	month: string;
	ym: string;
	income: number;
	expenses: number;
	net: number;
}

function buildYtdChartData(monthly: MonthlyData | null): ChartPoint[] {
	const months = ytdMonths();
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
				const { val } = extractAmount(row.prrAmounts?.[idx] ?? []);
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

	const monthLabels: (string | null)[] = weeks.map(week => {
		const first = week.find(d => d && d.date.slice(8) === '01');
		if (!first) return null;
		return new Date(first.date + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short' });
	});

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
									onClick={() => day && onDayClick(day.date)}
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
				<div className="drilldown-loading">No activity on this day.</div>
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

// ── Spending vs Prior chart ───────────────────────────────────────────────────

type CompareMode = 'last-month' | 'rolling-avg';

function SpendingChart({ chartData }: { chartData: ChartPoint[] }) {
	const { privacyMode } = usePrivacy();
	const [mode, setMode] = useState<CompareMode>('last-month');

	const lastMonth = chartData[chartData.length - 2];
	const thisMonth = chartData[chartData.length - 1];

	const priorMonths = chartData.slice(0, -1);
	const last3 = priorMonths.slice(-3);
	const rollingAvg = last3.reduce((s, d) => s + d.expenses, 0) / Math.max(1, last3.length);

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
					<Tooltip
						formatter={(v) => [privacyMode ? '••••' : `$${Number(v).toFixed(2)}`, 'Spending']}
						labelStyle={{ fontSize: 11 }}
						contentStyle={TOOLTIP_STYLE}
					/>
					<Bar dataKey="expenses" fill={TEAL} radius={[4, 4, 0, 0]} />
				</BarChart>
			</ResponsiveContainer>
		</div>
	);
}

// ── Spending Pace card ────────────────────────────────────────────────────────

function SpendingPaceCard({ chartData }: { chartData: ChartPoint[] }) {
	const today = new Date();
	const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
	const dayElapsed = today.getDate();
	const daysPct = dayElapsed / daysInMonth;

	const currentYm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
	const currentData = chartData.find(d => d.ym === currentYm);
	const currentSpend = currentData?.expenses ?? 0;

	const priorMonths = chartData.filter(d => d.ym < currentYm);
	const avgMonthly = priorMonths.length > 0
		? priorMonths.reduce((s, d) => s + d.expenses, 0) / priorMonths.length
		: null;

	const spendPct = avgMonthly && avgMonthly > 0 ? currentSpend / avgMonthly : null;
	const isAhead = spendPct !== null && spendPct > daysPct + 0.1;

	const monthName = new Date(currentYm + '-01T00:00:00').toLocaleDateString('en-CA', { month: 'long' });

	return (
		<div className="dash-chart-card">
			<div className="dash-chart-header">
				<span className="dash-chart-title">Spending Pace — {monthName}</span>
				{isAhead && <span className="pace-fast-badge">RUNNING FAST</span>}
			</div>

			<div className="pace-row">
				<span className="pace-label">Days elapsed</span>
				<div className="pace-bar-track">
					<div className="pace-bar-fill" style={{ width: `${(daysPct * 100).toFixed(1)}%` }} />
				</div>
				<span className="pace-pct">{Math.round(daysPct * 100)}%</span>
			</div>

			<div className="pace-row">
				<span className="pace-label">Spent vs avg</span>
				<div className="pace-bar-track">
					{spendPct !== null ? (
						<div
							className={`pace-bar-fill${isAhead ? ' ahead' : ''}`}
							style={{ width: `${Math.min(spendPct * 100, 100).toFixed(1)}%` }}
						/>
					) : (
						<div className="pace-bar-fill" style={{ width: '0%' }} />
					)}
				</div>
				<span className="pace-pct">
					{spendPct !== null ? `${Math.round(spendPct * 100)}%` : '—'}
				</span>
			</div>

			<div className="pace-detail">
				Day {dayElapsed} of {daysInMonth} · Spent: <MaskedAmount value={currentSpend} />
				{avgMonthly !== null && <> · Avg: <MaskedAmount value={avgMonthly} /></>}
			</div>
		</div>
	);
}

// ── Category by Month chart ───────────────────────────────────────────────────

interface TooltipEntry {
	name: string;
	value: number;
	fill: string;
}

function CategoryTooltip({
	active,
	payload,
	label,
}: {
	active?: boolean;
	payload?: TooltipEntry[];
	label?: string;
}) {
	const { privacyMode } = usePrivacy();
	if (!active || !payload?.length) return null;
	const nonZero = payload.filter(p => (p.value ?? 0) > 0);
	if (!nonZero.length) return null;
	const total = nonZero.reduce((s, p) => s + p.value, 0);
	return (
		<div className="cat-tooltip">
			<div className="cat-tooltip-month">{label}</div>
			{nonZero.map((p, i) => (
				<div key={i} className="cat-tooltip-row">
					<span className="cat-tooltip-dot" style={{ background: p.fill }} />
					<span className="cat-tooltip-name">{p.name}</span>
					<span className="cat-tooltip-val">{privacyMode ? '••••' : `$${p.value.toFixed(2)}`}</span>
				</div>
			))}
			{nonZero.length > 1 && (
				<div className="cat-tooltip-total">
					<span>Total</span>
					<span>{privacyMode ? '••••' : `$${total.toFixed(2)}`}</span>
				</div>
			)}
		</div>
	);
}

function CategoryComparisonChart({
	monthlyDetail,
	ytdMonthsList,
}: {
	monthlyDetail: MonthlyData;
	ytdMonthsList: string[];
}) {
	const categories = useMemo(() => {
		const cats = new Set<string>();
		monthlyDetail.prRows.forEach(row => {
			if (row.prrName.startsWith('expenses:')) {
				const cat = row.prrName.split(':')[1];
				if (cat) cats.add(cat);
			}
		});
		return Array.from(cats).sort();
	}, [monthlyDetail]);

	const defaultCat = useMemo(
		() => categories.find(c => c.toLowerCase().includes('food')) ?? categories[0] ?? '',
		[categories],
	);

	const [selectedCat, setSelectedCat] = useState('');
	const activeCat = selectedCat || defaultCat;

	// ym → prDates index map, computed once
	const ymToIdx = useMemo(() => {
		const map: Record<string, number> = {};
		monthlyDetail.prDates.forEach((dateRange, idx) => {
			const ym = dateRange[0]?.contents?.slice(0, 7) ?? '';
			if (ym) map[ym] = idx;
		});
		return map;
	}, [monthlyDetail]);

	// Direct sub-accounts one level below activeCat
	const subAccounts = useMemo(() => {
		if (!activeCat) return [];
		const childPrefix = `expenses:${activeCat}:`;
		const subs = new Set<string>();
		monthlyDetail.prRows.forEach(row => {
			if (row.prrName.startsWith(childPrefix)) {
				const sub = row.prrName.slice(childPrefix.length).split(':')[0];
				if (sub) subs.add(sub);
			}
		});
		return Array.from(subs).sort();
	}, [monthlyDetail, activeCat]);

	// Build chart data: one entry per YTD month, one key per sub-account
	const catData = useMemo(() => {
		if (!activeCat) return [];
		const parentKey = `expenses:${activeCat}`;

		return ytdMonthsList.map(ym => {
			const point: Record<string, string | number> = { month: shortMonth(ym), ym };
			const idx = ymToIdx[ym];

			if (subAccounts.length === 0) {
				// No sub-accounts: aggregate everything under the parent
				let total = 0;
				monthlyDetail.prRows.forEach(row => {
					if (!row.prrName.startsWith(parentKey)) return;
					if (idx === undefined) return;
					total += Math.abs(extractAmount(row.prrAmounts?.[idx] ?? []).val);
				});
				point['total'] = total;
			} else {
				subAccounts.forEach(sub => {
					const subPrefix = `${parentKey}:${sub}`;
					let total = 0;
					monthlyDetail.prRows.forEach(row => {
						if (!row.prrName.startsWith(subPrefix) || idx === undefined) return;
						total += Math.abs(extractAmount(row.prrAmounts?.[idx] ?? []).val);
					});
					point[sub] = total;
				});
			}

			return point;
		});
	}, [monthlyDetail, activeCat, subAccounts, ytdMonthsList, ymToIdx]);

	if (categories.length === 0) return null;

	const barKeys = subAccounts.length > 0 ? subAccounts : ['total'];

	return (
		<div className="dash-chart-card">
			<div className="dash-chart-header">
				<span className="dash-chart-title">Category by Month</span>
			</div>
			<div className="cat-picker">
				{categories.map(cat => (
					<button
						key={cat}
						className={`cat-pill${activeCat === cat ? ' active' : ''}`}
						onClick={() => setSelectedCat(cat)}
					>
						{cat}
					</button>
				))}
			</div>
			<ResponsiveContainer width="100%" height={150}>
				<BarChart data={catData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
					<XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
					<YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={36} />
					<Tooltip content={(props) => (
						<CategoryTooltip
							active={props.active}
							payload={props.payload as unknown as TooltipEntry[] | undefined}
							label={String(props.label ?? '')}
						/>
					)} />
					{barKeys.map((key, i) => (
						<Bar
							key={key}
							dataKey={key}
							stackId="a"
							fill={TEAL_PALETTE[i % TEAL_PALETTE.length]}
							radius={i === barKeys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
						/>
					))}
				</BarChart>
			</ResponsiveContainer>
			{subAccounts.length > 1 && (
				<div className="cat-legend">
					{subAccounts.map((sub, i) => (
						<div key={sub} className="cat-legend-item">
							<span className="cat-legend-dot" style={{ background: TEAL_PALETTE[i % TEAL_PALETTE.length] }} />
							<span>{sub}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ── End of Month Recap card ───────────────────────────────────────────────────

function EndOfMonthRecap({
	chartData,
	monthly,
	dailyTotals,
}: {
	chartData: ChartPoint[];
	monthly: MonthlyData;
	dailyTotals: DailyTotal[] | null;
}) {
	const { privacyMode } = usePrivacy();
	const today = new Date();
	const dayOfMonth = today.getDate();
	const currentYm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

	const reportYm = (dayOfMonth <= 21 && chartData.length >= 2)
		? chartData[chartData.length - 2].ym
		: currentYm;

	const reportData = chartData.find(d => d.ym === reportYm);
	if (!reportData) return null;

	const isCurrentMonth = reportYm === currentYm;
	const monthName = new Date(reportYm + '-01T00:00:00').toLocaleDateString('en-CA', { month: 'long' });
	const heading = isCurrentMonth ? `${monthName} so far` : `${monthName} recap`;

	const txnCount = dailyTotals
		? dailyTotals.filter(d => d.date.startsWith(reportYm)).reduce((s, d) => s + d.count, 0)
		: null;

	const reportIdx = monthly.prDates.findIndex(d => d[0]?.contents?.slice(0, 7) === reportYm);
	const catTotals: Record<string, number> = {};
	if (reportIdx >= 0) {
		monthly.prRows.forEach(row => {
			if (!row.prrName.startsWith('expenses:')) return;
			const cat = row.prrName.split(':')[1];
			if (!cat) return;
			const { val } = extractAmount(row.prrAmounts?.[reportIdx] ?? []);
			if (val !== 0) catTotals[cat] = (catTotals[cat] ?? 0) + Math.abs(val);
		});
	}
	const biggestCat = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];

	const priorMonths = chartData.filter(d => d.ym < reportYm);
	const avg = priorMonths.length > 0
		? priorMonths.reduce((s, d) => s + d.expenses, 0) / priorMonths.length
		: null;

	let paceNote: string | null = null;
	if (isCurrentMonth && avg !== null && avg > 0) {
		const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
		const spendPct = reportData.expenses / avg;
		const daysPct = dayOfMonth / daysInMonth;
		const delta = spendPct - daysPct;
		if (delta > 0.1) paceNote = 'Running ahead of your typical monthly pace';
		else if (delta < -0.1) paceNote = 'Running below your typical monthly pace';
		else paceNote = 'On track with your typical monthly pace';
	}

	return (
		<div className="dash-chart-card">
			<div className="recap-heading">{heading}</div>

			<div className="recap-stat">
				<span className="recap-stat-label">Spent</span>
				<MaskedAmount value={reportData.expenses} />
			</div>

			{txnCount !== null && txnCount > 0 && (
				<div className="recap-stat">
					<span className="recap-stat-label">Transactions</span>
					<span>{txnCount}</span>
				</div>
			)}

			{biggestCat && (
				<div className="recap-stat">
					<span className="recap-stat-label">Biggest category</span>
					<span>
						{biggestCat[0]}
						{!privacyMode && ` · $${biggestCat[1].toFixed(0)}`}
					</span>
				</div>
			)}

			{avg !== null && !isCurrentMonth && (
				<div className="recap-stat">
					<span className="recap-stat-label">vs avg</span>
					<span style={{ color: reportData.expenses > avg ? CORAL : TEAL }}>
						{reportData.expenses > avg ? '▲' : '▼'}{' '}
						{Math.abs((reportData.expenses - avg) / avg * 100).toFixed(0)}%{' '}
						{reportData.expenses > avg ? 'above' : 'below'}
					</span>
				</div>
			)}

			{paceNote && <div className="recap-note">{paceNote}</div>}
		</div>
	);
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function DashboardView({ isActive, monthly, syncKey }: Props) {
	const [dailyTotals, setDailyTotals] = useState<DailyTotal[] | null>(null);
	const [dailyError, setDailyError] = useState(false);
	const [selectedDay, setSelectedDay] = useState<string | null>(null);
	const [txnsByMonth, setTxnsByMonth] = useState<Record<string, Transaction[]>>({});
	const [dayLoading, setDayLoading] = useState(false);
	const [monthlyDetail, setMonthlyDetail] = useState<MonthlyData | null>(null);
	const [monthlyDetailError, setMonthlyDetailError] = useState(false);

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

	const fetchMonthlyDetail = useCallback(async () => {
		try {
			const data = await loadRawEndpoint<MonthlyData>('monthly-detail');
			setMonthlyDetail(data);
		} catch {
			setMonthlyDetailError(true);
		}
	}, []);

	useEffect(() => {
		if (isActive && !dailyTotals && !dailyError) void fetchDailyTotals();
	}, [isActive, dailyTotals, dailyError, fetchDailyTotals]);

	useEffect(() => {
		if (isActive && !monthlyDetail && !monthlyDetailError) void fetchMonthlyDetail();
	}, [isActive, monthlyDetail, monthlyDetailError, fetchMonthlyDetail]);

	useEffect(() => {
		if (syncKey > 0) {
			setDailyTotals(null);
			setDailyError(false);
			setMonthlyDetail(null);
			setMonthlyDetailError(false);
			setTxnsByMonth({});
			void fetchDailyTotals();
			void fetchMonthlyDetail();
		}
	}, [syncKey, fetchDailyTotals, fetchMonthlyDetail]);

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

	const ytdMonthsList = useMemo(ytdMonths, []);
	const chartData = useMemo(() => buildYtdChartData(monthly), [monthly]);

	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-dashboard">
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

			<VerseCard />

			{!monthly ? (
				<div className="state-msg">Tap sync to load chart data.</div>
			) : (
				<>
					<SpendingChart chartData={chartData} />
					<SpendingPaceCard chartData={chartData} />
					{monthlyDetail && (
						<CategoryComparisonChart monthlyDetail={monthlyDetail} ytdMonthsList={ytdMonthsList} />
					)}
					<EndOfMonthRecap chartData={chartData} monthly={monthly} dailyTotals={dailyTotals} />
				</>
			)}
		</div>
	);
}
