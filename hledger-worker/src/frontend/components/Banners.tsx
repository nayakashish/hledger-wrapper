interface Props {
	isOffline: boolean;
	serverDown: boolean;
	syncTimestamp: string;
}

export default function Banners({ isOffline, serverDown, syncTimestamp }: Props) {
	// No network wins: the phone can't tell anything about the server then.
	if (isOffline) {
		return <div className="offline-banner visible">You are offline — showing cached data</div>;
	}
	return (
		<div className={`offline-banner server${serverDown ? ' visible' : ''}`}>
			Can't reach the server{syncTimestamp ? ` — ${syncTimestamp}` : ''}
		</div>
	);
}
