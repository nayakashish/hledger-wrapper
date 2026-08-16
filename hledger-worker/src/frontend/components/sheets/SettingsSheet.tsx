import { useState, useEffect, useCallback } from 'react';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { apiGet, apiPost } from '../../utils/api';
import type { JournalInfo } from '../../types';

interface Props {
	isOpen: boolean;
	onClose: () => void;
	onJournalSwitch: () => Promise<void>;
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

	useEffect(() => {
		if (isOpen) {
			setSection('root');
			void loadJournals();
		}
	}, [isOpen, loadJournals]);

	if (!isOpen) return null;

	const activeName = journals?.find(j => j.active)?.name ?? '';

	const handleSelect = async (name: string) => {
		if (switching || name === activeName) return;
		setSwitching(true);
		try {
			await apiPost('/api/journals/select', { name });
			setJournals(prev => (prev ? prev.map(j => ({ ...j, active: j.name === name })) : prev));
			showToast(`Switched to ${name}`);
			await onJournalSwitch();
		} catch (e) {
			showToast('Switch failed: ' + (e instanceof Error ? e.message : String(e)), 4000);
		} finally {
			setSwitching(false);
		}
	};

	return (
		<div className="assign-sheet">
			<div className="assign-sheet-inner">
				<div className="assign-header">
					<div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
						{section !== 'root' && (
							<button className="assign-close" onClick={() => setSection('root')} aria-label="Back to settings">
								←
							</button>
						)}
						<span className="assign-title">{section === 'config' ? 'Config' : 'Settings'}</span>
					</div>
					<button className="assign-close" onClick={onClose}>✕</button>
				</div>
				<div className="assign-body">
					{section === 'root' ? (
						<button className="settings-row" onClick={() => setSection('config')}>
							<div className="settings-row-main">
								<div className="settings-row-title">Config</div>
								<div className="settings-row-sub">
									Active journal{activeName ? ` · ${activeName}` : ''}
								</div>
							</div>
							<span className="settings-chevron">›</span>
						</button>
					) : (
						<ConfigSection
							journals={journals}
							loading={loading}
							switching={switching}
							onSelect={handleSelect}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

function ConfigSection({
	journals,
	loading,
	switching,
	onSelect,
}: {
	journals: JournalInfo[] | null;
	loading: boolean;
	switching: boolean;
	onSelect: (name: string) => Promise<void>;
}) {
	return (
		<>
			<div className="settings-field-label">Active journal</div>
			{loading && journals === null ? (
				<div className="inbox-empty">Loading...</div>
			) : !journals || journals.length === 0 ? (
				<div className="inbox-empty">No journals found</div>
			) : (
				journals.map(j => (
					<button
						key={j.name}
						className={`settings-radio${j.active ? ' active' : ''}`}
						disabled={switching}
						onClick={() => void onSelect(j.name)}
					>
						<span className="settings-radio-dot" aria-hidden="true" />
						<span className="settings-radio-label">{j.name}</span>
						{j.active && <span className="settings-radio-check">✓</span>}
					</button>
				))
			)}
			<div className="settings-hint">
				Switching repoints every report, transaction search, and the envelopes/inbox to the
				selected journal.
			</div>
		</>
	);
}
