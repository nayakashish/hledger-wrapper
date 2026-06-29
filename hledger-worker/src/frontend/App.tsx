import { useState, useCallback, useEffect, useRef } from 'react';
import type {
	ViewName,
	AppCache,
	Transaction,
	EnvelopeData,
	PendingTxn,
	DetailContent,
	BalanceRow,
} from './types';
import { formatSyncTime, currentMonth } from './utils/format';
import { loadRawEndpoint, apiPost } from './utils/api';
import Banners from './components/Banners';
import Header from './components/Header';
import SyncRow from './components/SyncRow';
import SummaryCards from './components/SummaryCards';
import Nav from './components/Nav';
import BalanceView from './components/views/BalanceView';
import MonthlyView from './components/views/MonthlyView';
import TransactionsView from './components/views/TransactionsView';
import EnvelopesView from './components/views/EnvelopesView';
import AddSheet from './components/sheets/AddSheet';
import DetailSheet from './components/sheets/DetailSheet';
import AssignSheet from './components/sheets/AssignSheet';
import PinModal from './components/modals/PinModal';
import Toast from './components/Toast';

const CACHE_KEY = 'hledger_cache';
const SYNC_KEY = 'hledger_last_sync';
const ENV_CACHE_KEY = 'hledger_envelopes_v3';

function loadPersistedCache(): AppCache {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		return raw ? (JSON.parse(raw) as AppCache) : {};
	} catch {
		return {};
	}
}

function persistCache(cache: AppCache, envData: EnvelopeData | null) {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
		localStorage.setItem(SYNC_KEY, new Date().toISOString());
		if (envData) localStorage.setItem(ENV_CACHE_KEY, JSON.stringify(envData));
	} catch {
		// storage full — ignore
	}
}

export default function App() {
	const [activeView, setActiveView] = useState<ViewName>('balance');
	const [cache, setCache] = useState<AppCache>(loadPersistedCache);
	const [envData, setEnvData] = useState<EnvelopeData | null>(() => {
		try {
			const r = localStorage.getItem(ENV_CACHE_KEY);
			return r ? (JSON.parse(r) as EnvelopeData) : null;
		} catch {
			return null;
		}
	});
	const [isDemoMode, setIsDemoMode] = useState(
		() => sessionStorage.getItem('hledger_demo') === '1'
	);
	const [isOffline, setIsOffline] = useState(!navigator.onLine);
	const [syncTimestamp, setSyncTimestamp] = useState(() => {
		try {
			const ts = localStorage.getItem(SYNC_KEY);
			return ts ? formatSyncTime(ts) : '';
		} catch {
			return '';
		}
	});
	const [isSyncing, setIsSyncing] = useState(false);
	const [accountsList, setAccountsList] = useState<string[]>(() => {
		try {
			const c = localStorage.getItem('hledger_accounts');
			return c ? (JSON.parse(c) as string[]) : [];
		} catch {
			return [];
		}
	});
	const [descriptionsList, setDescriptionsList] = useState<string[]>(() => {
		try {
			const c = localStorage.getItem('hledger_descriptions');
			return c ? (JSON.parse(c) as string[]) : [];
		} catch {
			return [];
		}
	});

	// Sheets and modals
	const [addSheetOpen, setAddSheetOpen] = useState(false);
	const [detailContent, setDetailContent] = useState<DetailContent | null>(null);
	const [assignTxn, setAssignTxn] = useState<PendingTxn | null>(null);
	const [pinModalOpen, setPinModalOpen] = useState(false);

	// Toast
	const [toastMsg, setToastMsg] = useState('');
	const [toastVisible, setToastVisible] = useState(false);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const showToast = useCallback((msg: string, duration = 2500) => {
		setToastMsg(msg);
		setToastVisible(true);
		if (toastTimer.current) clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToastVisible(false), duration);
	}, []);

	// Online/offline
	useEffect(() => {
		const onOnline = () => {
			setIsOffline(false);
			document.body.classList.remove('is-offline');
		};
		const onOffline = () => {
			setIsOffline(true);
			document.body.classList.add('is-offline');
		};
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);
		if (!navigator.onLine) document.body.classList.add('is-offline');
		return () => {
			window.removeEventListener('online', onOnline);
			window.removeEventListener('offline', onOffline);
		};
	}, []);

	// Demo mode
	useEffect(() => {
		if (isDemoMode) {
			document.body.classList.add('is-demo');
		} else {
			document.body.classList.remove('is-demo');
		}
	}, [isDemoMode]);

	const fetchAccounts = useCallback(
		async (demo: boolean) => {
			if (demo) return;
			try {
				const json = await (
					await fetch('/api/accounts')
				).json() as { accounts?: string[] };
				const list = json.accounts || [];
				setAccountsList(list);
				localStorage.setItem('hledger_accounts', JSON.stringify(list));
			} catch {
				// fail silently
			}
		},
		[]
	);

	const fetchDescriptions = useCallback(
		async (demo: boolean) => {
			if (demo) return;
			try {
				const json = await (
					await fetch('/api/descriptions')
				).json() as { descriptions?: string[] };
				const list = json.descriptions || [];
				setDescriptionsList(list);
				localStorage.setItem('hledger_descriptions', JSON.stringify(list));
			} catch {
				// fail silently
			}
		},
		[]
	);

	const loadEnvelopes = useCallback(async (demo: boolean) => {
		if (demo) return;
		try {
			const data = await (
				await fetch('/api/envelopes')
			).json() as EnvelopeData;
			setEnvData(data);
			setCache(prev => ({ ...prev, envelopes: data }));
			localStorage.setItem(ENV_CACHE_KEY, JSON.stringify(data));
		} catch {
			// fail silently
		}
	}, []);

	const loadAll = useCallback(async (demo: boolean) => {
		const month = currentMonth();
		const [balance, , monthly, transactions] = await Promise.allSettled([
			loadRawEndpoint<BalanceRow[][]>('balance', demo),
			loadRawEndpoint<unknown>('is', demo),
			loadRawEndpoint<unknown>('monthly', demo),
			loadRawEndpoint<Transaction[]>('transactions', demo, { month }),
		]);

		setCache(prev => {
			const next = { ...prev };
			if (balance.status === 'fulfilled') next.balance = balance.value;
			if (monthly.status === 'fulfilled') next.monthly = monthly.value as AppCache['monthly'];
			if (transactions.status === 'fulfilled') next.transactions = transactions.value;
			return next;
		});

		await loadEnvelopes(demo);
		await fetchAccounts(demo);
		await fetchDescriptions(demo);
	}, [loadEnvelopes, fetchAccounts, fetchDescriptions]);

	const enterDemoMode = useCallback(() => {
		sessionStorage.setItem('hledger_demo', '1');
		setIsDemoMode(true);
		showToast('Demo mode on');
		void loadAll(true);
	}, [showToast, loadAll]);

	const exitDemoMode = useCallback(() => {
		sessionStorage.removeItem('hledger_demo');
		setIsDemoMode(false);
		showToast('Back to your data');
		void loadAll(false);
	}, [showToast, loadAll]);

	const cacheRef = useRef(cache);
	const envDataRef = useRef(envData);
	cacheRef.current = cache;
	envDataRef.current = envData;

	const syncNow = useCallback(async () => {
		setIsSyncing(true);
		setSyncTimestamp('');
		try {
			if (!isDemoMode) {
				const r = await fetch('/api/sync', { method: 'POST' });
				if (!r.ok) {
					const j = await r.json() as { detail?: string };
					throw new Error(j.detail || `status ${r.status}`);
				}
				const syncResult = await r.json() as { detail?: string };
				if (syncResult.detail?.toLowerCase().includes('conflict')) {
					showToast('Sync conflict — check journal manually', 4000);
					return;
				}
			}
			await loadAll(isDemoMode);
			const now = new Date().toISOString();
			persistCache(cacheRef.current, envDataRef.current);
			setSyncTimestamp(formatSyncTime(now));
		} catch (e) {
			showToast('Sync failed: ' + (e instanceof Error ? e.message : String(e)), 4000);
		} finally {
			setIsSyncing(false);
		}
	}, [isDemoMode, loadAll, showToast]);

	// Envelope actions
	const scanTransactions = useCallback(async () => {
		try {
			showToast('Scanning...');
			const r = await apiPost<{ added?: number }>('/api/envelopes/scan', {});
			const added = r.added || 0;
			showToast(
				added > 0
					? `Found ${added} new transaction${added === 1 ? '' : 's'}`
					: 'Nothing new'
			);
			await loadEnvelopes(isDemoMode);
		} catch (e) {
			showToast('Scan failed: ' + (e instanceof Error ? e.message : String(e)), 4000);
		}
	}, [isDemoMode, loadEnvelopes, showToast]);

	const handleAddSuccess = useCallback(async () => {
		showToast('Saved — syncing...');
		await syncNow();
	}, [syncNow, showToast]);

	const handleEnvAction = useCallback(async () => {
		await loadEnvelopes(isDemoMode);
	}, [isDemoMode, loadEnvelopes]);

	return (
		<>
			<Banners
				isDemoMode={isDemoMode}
				isOffline={isOffline}
				onDemoTap={() => setPinModalOpen(true)}
			/>
			<div className="app">
				<Header onDemoTrigger={enterDemoMode} />
				<SyncRow
					isSyncing={isSyncing}
					onSync={syncNow}
					onAdd={() => {
						if (isDemoMode) {
							showToast('Add disabled in demo mode', 2500);
							return;
						}
						setAddSheetOpen(true);
					}}
					syncTimestamp={syncTimestamp}
				/>
				<SummaryCards balance={cache.balance ?? null} />
				<Nav activeView={activeView} onViewChange={setActiveView} />

				<BalanceView
					data={cache.balance ?? null}
					isActive={activeView === 'balance'}
				/>
				<MonthlyView
					data={cache.monthly ?? null}
					isActive={activeView === 'monthly'}
				/>
				<TransactionsView
					data={cache.transactions ?? null}
					isActive={activeView === 'transactions'}
					isDemoMode={isDemoMode}
					onTxnClick={txn => setDetailContent({ kind: 'transaction', txn })}
				/>
				<EnvelopesView
					data={envData}
					balanceData={cache.balance ?? null}
					isActive={activeView === 'envelopes'}
					onEnvClick={id => setDetailContent({ kind: 'envelope', envId: id })}
					onAssignClick={txn => setAssignTxn(txn)}
					onScan={scanTransactions}
					onNewEnv={() => setDetailContent({ kind: 'new-envelope' })}
				/>
			</div>

			<Toast message={toastMsg} visible={toastVisible} />

			<AddSheet
				isOpen={addSheetOpen}
				onClose={() => setAddSheetOpen(false)}
				onSuccess={handleAddSuccess}
				accountsList={accountsList}
				descriptionsList={descriptionsList}
				showToast={showToast}
			/>

			<DetailSheet
				content={detailContent}
				envData={envData}
				onClose={() => setDetailContent(null)}
				onEnvAction={handleEnvAction}
				showToast={showToast}
			/>

			<AssignSheet
				txn={assignTxn}
				envData={envData}
				onClose={() => setAssignTxn(null)}
				onSuccess={handleEnvAction}
				showToast={showToast}
			/>

			{pinModalOpen && (
				<PinModal
					onClose={() => setPinModalOpen(false)}
					onSuccess={exitDemoMode}
				/>
			)}
		</>
	);
}
