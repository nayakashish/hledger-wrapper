import { useEffect, useState } from 'react';
import { isServerDown, probeServer, subscribeServerHealth } from '../utils/serverHealth';

const RETRY_MS = 60_000;

// True while the API server can't be reached. Normal requests mark it down
// and up; while it's down, this also checks back every minute, on
// reconnecting, and when the app returns to the foreground.
export function useServerHealth(): boolean {
	const [down, setDown] = useState(isServerDown);

	useEffect(() => subscribeServerHealth(setDown), []);

	useEffect(() => {
		if (!down) return;
		const onVisible = () => {
			if (document.visibilityState === 'visible') void probeServer();
		};
		const timer = setInterval(() => void probeServer(), RETRY_MS);
		window.addEventListener('online', onVisible);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(timer);
			window.removeEventListener('online', onVisible);
			document.removeEventListener('visibilitychange', onVisible);
		};
	}, [down]);

	return down;
}
