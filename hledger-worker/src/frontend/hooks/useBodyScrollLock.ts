import { useEffect } from 'react';

// Locks background scrolling while a sheet is open. Plain `overflow: hidden`
// on <body> is ignored by iOS Safari (the page still rubber-bands behind the
// sheet), so we pin the body with `position: fixed` and offset it by the
// current scroll position, restoring both on release. Ref-counted so multiple
// open sheets don't unlock each other.

let lockCount = 0;
let savedScrollY = 0;

function lock() {
	if (lockCount === 0) {
		savedScrollY = window.scrollY;
		const body = document.body.style;
		body.position = 'fixed';
		body.top = `-${savedScrollY}px`;
		body.left = '0';
		body.right = '0';
		body.width = '100%';
	}
	lockCount++;
}

function unlock() {
	lockCount = Math.max(0, lockCount - 1);
	if (lockCount === 0) {
		const body = document.body.style;
		body.position = '';
		body.top = '';
		body.left = '';
		body.right = '';
		body.width = '';
		window.scrollTo(0, savedScrollY);
	}
}

export function useBodyScrollLock(active: boolean) {
	useEffect(() => {
		if (!active) return;
		lock();
		return unlock;
	}, [active]);
}
