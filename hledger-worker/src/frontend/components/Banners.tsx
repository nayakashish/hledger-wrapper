interface Props {
	isDemoMode: boolean;
	isOffline: boolean;
	onDemoTap: () => void;
}

export default function Banners({ isDemoMode, isOffline, onDemoTap }: Props) {
	return (
		<>
			<div
				className={`demo-banner${isDemoMode ? ' visible' : ''}`}
				onClick={onDemoTap}
			>
				Demo mode — tap to exit
			</div>
			<div className={`offline-banner${isOffline ? ' visible' : ''}`}>
				You are offline — showing cached data
			</div>
		</>
	);
}
