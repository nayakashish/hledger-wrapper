import { useRef, useCallback } from 'react';

interface Props {
	onDemoTrigger: () => void;
}

export default function Header({ onDemoTrigger }: Props) {
	const tapCount = useRef(0);
	const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleTap = useCallback(() => {
		tapCount.current++;
		if (tapTimer.current) clearTimeout(tapTimer.current);
		tapTimer.current = setTimeout(() => { tapCount.current = 0; }, 600);
		if (tapCount.current >= 3) {
			tapCount.current = 0;
			if (tapTimer.current) clearTimeout(tapTimer.current);
			onDemoTrigger();
		}
	}, [onDemoTrigger]);

	return (
		<header>
			<h1
				onTouchEnd={e => { e.preventDefault(); handleTap(); }}
				onClick={() => { if ('ontouchend' in window) return; handleTap(); }}
			>
				hledger <span>— nayakashish</span>
			</h1>
		</header>
	);
}
