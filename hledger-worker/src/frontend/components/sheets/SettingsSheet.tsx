import { useState, useEffect, useCallback } from 'react';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { apiGet, apiPost } from '../../utils/api';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from '../Icons';
import type { JournalInfo, VersionInfo } from '../../types';

interface Props {
	isOpen: boolean;
	onClose: () => void;
	onJournalSwitch: (journalName: string) => Promise<void>;
	showToast: (msg: string, duration?: number) => void;
}

// Settings is a menu-like sheet with drill-in sections. For now the only
// section is Config, whose only field is the active journal.
type Section = 'root' | 'config';

export default function SettingsSheet({ isOpen, onClose, onJournalSwitch, showToast }: Props) {
	const [section, setSection] = useState<Section>('root');
	const [journals, setJournals] = useState<JournalInfo[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [switching, setSwitching] = useState(false);
	const [switchingInbox, setSwitchingInbox] = useState(false);
	const [apiVersion, setApiVersion] = useState<VersionInfo | null>(null);
	const [apiVersionFailed, setApiVersionFailed] = useState(false);

	useBodyScrollLock(isOpen);

	const loadJournals = useCallback(async () => {
		setLoading(true);
		try {
			const r = await apiGet<{ journals: JournalInfo[] }>('/api/journals');
			setJournals(r.journals || []);
		} catch (e) {
			showToast('Could not load journals: ' + (e instanceof Error ? e.message : String(e)), 4000);
			setJournals([]);
		} finally {
			setLoading(false);
		}
	}, [showToast]);

	// Not cached: a stale answer would hide the case worth catching, which is a
	// server running older code than the app talking to it.
	const loadVersion = useCallback(async () => {
		setApiVersionFailed(false);
		try {
			setApiVersion(await apiGet<VersionInfo>('/api/version'));
		} catch {
			setApiVersionFailed(true);
		}
	}, []);

	useEffect(() => {
		if (isOpen) {
			setSection('root');
			void loadJournals();
			void loadVersion();
		}
	}, [isOpen, loadJournals, loadVersion]);

	if (!isOpen) return null;

	const activeName = journals?.find(j => j.active)?.name ?? '';
	const inboxName = journals?.find(j => j.inbox)?.name ?? '';

	const handleSelect = async (name: string) => {
		if (switching || name === activeName) return;
		setSwitching(true);
		try {
			await apiPost('/api/journals/select', { name });
			setJournals(prev => (prev ? prev.map(j => ({ ...j, active: j.name === name })) : prev));
			showToast(`Switched to ${name}`);
			await onJournalSwitch(name);
		} catch (e) {
			showToast('Switch failed: ' + (e instanceof Error ? e.message : String(e)), 4000);
		} finally {
			setSwitching(false);
		}
	};

	// The inbox (email-ingest) journal only controls where bank alerts land —
	// it never affects what's on screen, so unlike handleSelect this doesn't
	// touch caches or call onJournalSwitch.
	const handleSelectInbox = async (name: string) => {
		if (switchingInbox || name === inboxName) return;
		setSwitchingInbox(true);
		try {
			await apiPost('/api/journals/select-inbox', { name });
			setJournals(prev => (prev ? prev.map(j => ({ ...j, inbox: j.name === name })) : prev));
			showToast(`Bank alerts will now land in ${name}`);
		} catch (e) {
			showToast('Switch failed: ' + (e instanceof Error ? e.message : String(e)), 4000);
		} finally {
			setSwitchingInbox(false);
		}
	};

	return (
		<div className="assign-sheet">
			<div className="assign-sheet-inner">
				<div className="assign-header">
					<div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
						{section !== 'root' && (
							<button className="assign-close" onClick={() => setSection('root')} aria-label="Back to settings">
								<ChevronLeftIcon />
							</button>
						)}
						<span className="assign-title">{section === 'config' ? 'Config' : 'Settings'}</span>
					</div>
					<button className="assign-close" onClick={onClose} aria-label="Close settings">
						<CloseIcon />
					</button>
				</div>
				<div className={`assign-body${section === 'root' ? ' settings-body' : ''}`}>
					{section === 'root' ? (
						<>
						<button className="settings-row" onClick={() => setSection('config')}>
							<div className="settings-row-main">
								<div className="settings-row-title">Config</div>
								<div className="settings-row-sub">
									Active{activeName ? ` · ${activeName}` : ''}
									{' · '}Inbox{inboxName ? ` · ${inboxName}` : ' · not set'}
								</div>
							</div>
							<span className="settings-chevron"><ChevronRightIcon size={16} /></span>
						</button>
						<VersionBlock info={apiVersion} failed={apiVersionFailed} />
						</>
					) : (
						<ConfigSection
							journals={journals}
							loading={loading}
							switching={switching}
							switchingInbox={switchingInbox}
							onSelect={handleSelect}
							onSelectInbox={handleSelectInbox}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

// ── Versions ──────────────────────────────────────────────────────────────────

function relativeDay(iso: string): string {
	const then = new Date(iso);
	if (isNaN(then.getTime())) return '';
	const days = Math.floor((Date.now() - then.getTime()) / 86400000);
	if (days <= 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days < 30) return `${days}d ago`;
	return then.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

/** What each side reports about itself. The app's half is baked in at build
 * time (see vite.config.ts); the API reads it off its own checkout. Shown
 * together because the useful question is whether they agree — a deploy that
 * updated one side and not the other is otherwise invisible. */
function VersionBlock({ info, failed }: { info: VersionInfo | null; failed: boolean }) {
	const mismatch = !!info?.version && info.version !== __APP_VERSION__;

	return (
		<div className="version-footer">
			<div className="settings-field-label">Versions</div>
			<div className="version-row">
				<span className="version-label">App</span>
				<span className="version-value">
					{__APP_VERSION__}
					{__APP_COMMIT__ && <span className="version-commit">{__APP_COMMIT__}</span>}
				</span>
			</div>
			<div className="version-row">
				<span className="version-label">API</span>
				<span className="version-value">
					{failed ? (
						<span className="version-muted">unavailable</span>
					) : !info ? (
						<span className="version-muted">checking…</span>
					) : (
						<>
							{info.version || <span className="version-muted">unknown</span>}
							{info.commit && <span className="version-commit">{info.commit}</span>}
						</>
					)}
				</span>
			</div>
			{info && (info.branch || info.dirty || info.committed_at) && (
				<div className="version-detail">
					{[
						info.branch ? `API on branch ${info.branch}` : '',
						info.committed_at ? `committed ${relativeDay(info.committed_at)}` : '',
						info.dirty ? 'with uncommitted changes' : '',
					].filter(Boolean).join(' · ')}
				</div>
			)}
			{mismatch && (
				<div className="settings-hint version-mismatch">
					The app and the API are on different versions — one side was deployed without
					the other.
				</div>
			)}
		</div>
	);
}

function JournalRadioGroup({
	journals,
	isSelected,
	disabled,
	onSelect,
}: {
	journals: JournalInfo[];
	isSelected: (j: JournalInfo) => boolean;
	disabled: boolean;
	onSelect: (name: string) => Promise<void>;
}) {
	return (
		<>
			{journals.map(j => {
				const active = isSelected(j);
				return (
					<button
						key={j.name}
						className={`settings-radio${active ? ' active' : ''}`}
						disabled={disabled}
						aria-pressed={active}
						onClick={() => void onSelect(j.name)}
					>
						<span className="settings-radio-dot" aria-hidden="true" />
						<span className="settings-radio-label">{j.name}</span>
					</button>
				);
			})}
		</>
	);
}

function ConfigSection({
	journals,
	loading,
	switching,
	switchingInbox,
	onSelect,
	onSelectInbox,
}: {
	journals: JournalInfo[] | null;
	loading: boolean;
	switching: boolean;
	switchingInbox: boolean;
	onSelect: (name: string) => Promise<void>;
	onSelectInbox: (name: string) => Promise<void>;
}) {
	if (loading && journals === null) {
		return <div className="inbox-empty">Loading...</div>;
	}
	if (!journals || journals.length === 0) {
		return <div className="inbox-empty">No journals found</div>;
	}

	const inboxCandidates = journals.filter(j => !j.demo);

	return (
		<>
			<div className="settings-field-label">Active journal</div>
			<JournalRadioGroup
				journals={journals}
				isSelected={j => j.active}
				disabled={switching}
				onSelect={onSelect}
			/>
			<div className="settings-hint">
				Switching repoints every report, transaction search, and the envelopes/inbox to the
				selected journal.
			</div>

			<div className="settings-field-label">Inbox / email journal</div>
			{inboxCandidates.length === 0 ? (
				<div className="inbox-empty">No journals available (demo doesn't count)</div>
			) : (
				<JournalRadioGroup
					journals={inboxCandidates}
					isSelected={j => j.inbox}
					disabled={switchingInbox}
					onSelect={onSelectInbox}
				/>
			)}
			<div className="settings-hint">
				Bank alert emails always land in this journal's inbox, regardless of which journal
				you're viewing. The demo journal can't be picked here. Until one is set, incoming
				alerts are refused (they stay in Gmail and can be re-forwarded once you pick one).
			</div>
		</>
	);
}
