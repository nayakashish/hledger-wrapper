interface Props {
	isOffline: boolean;
}

export default function Banners({ isOffline }: Props) {
	return (
		<div className={`offline-banner${isOffline ? ' visible' : ''}`}>
			You are offline — showing cached data
		</div>
	);
}
