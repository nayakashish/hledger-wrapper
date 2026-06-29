interface Props {
	isSyncing: boolean;
	onSync: () => void;
	onAdd: () => void;
	syncTimestamp: string;
}

export default function SyncRow({ isSyncing, onSync, onAdd, syncTimestamp }: Props) {
	return (
		<div className="sync-row">
			<button className="sync-btn" onClick={onAdd}>+ Add</button>
			<button className="sync-btn" onClick={onSync} disabled={isSyncing}>
				{isSyncing ? 'Syncing...' : 'Sync'}
			</button>
			<span className="sync-timestamp">
				{isSyncing ? '' : (syncTimestamp || 'not synced yet')}
			</span>
		</div>
	);
}
