import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { extractAmount, fmtAmount, amountClass, localDate } from '../../utils/format';
import { loadRawEndpoint } from '../../utils/api';
import MaskedAmount from '../MaskedAmount';
import VerseCard from '../VerseCard';
import { CloseIcon } from '../Icons';
import type { DailyTotal, MonthlyData, Transaction } from '../../types';

// recharts is about half the bundle and nothing above the fold needs it.
const DashboardCharts = lazy(() => import('./DashboardCharts'));

interface Props {
	isActive: boolean;
	monthly: MonthlyData | null;
	syncKey: number;
	onTxnClick: (txn: Transaction) => void;
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
		const ds = localDate(d);
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
	onTxnClick,
}: {
	date: string;
	txns: Transaction[];
	loading: boolean;
	onClose: () => void;
	onTxnClick: (txn: Transaction) => void;
}) {
	const label = new Date(date + 'T00:00:00').toLocaleDateString('en-CA', {
		weekday: 'short', month: 'short', day: 'numeric',
	});

	return (
		<div className="day-detail">
			<div className="day-detail-header">
				<span className="day-detail-title">{label}</span>
				<button className="day-detail-close" onClick={onClose} aria-label="Close">
					<CloseIcon size={14} />
				</button>
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
					const isIncome = postings.some(p => (p.paccount || '').startsWith('income'));
					return (
						<div key={i} className="drilldown-txn" onClick={() => onTxnClick(txn)}>
							<div className="txn-top">
								<span className="txn-desc">{desc}</span>
								{isIncome ? (
									<MaskedAmount value={val} commodity={commodity} className={`txn-amount ${amountClass(val)}`} />
								) : (
									<span className={`txn-amount ${amountClass(val)}`}>
										{fmtAmount(val, commodity)}
									</span>
								)}
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

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function DashboardView({ isActive, monthly, syncKey, onTxnClick }: Props) {
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
							onTxnClick={onTxnClick}
						/>
					)}
				</>
			)}

			<VerseCard />

			{!monthly ? (
				<div className="state-msg">Tap sync to load chart data.</div>
			) : (
				<Suspense fallback={<div className="state-msg">Loading charts…</div>}>
					<DashboardCharts monthly={monthly} monthlyDetail={monthlyDetail} dailyTotals={dailyTotals} />
				</Suspense>
			)}
		</div>
	);
}
