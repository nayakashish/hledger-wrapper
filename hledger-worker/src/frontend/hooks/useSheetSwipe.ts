import { useEffect, RefObject } from 'react';

export function useSheetSwipe(
	sheetRef: RefObject<HTMLElement | null>,
	bodyRef: RefObject<HTMLElement | null>,
	onClose: () => void,
	isOpen: boolean
) {
	useEffect(() => {
		if (!isOpen) return;
		const sheet = sheetRef.current;
		const body = bodyRef.current;
		if (!sheet || !body) return;

		let startY = 0;
		let dragging = false;
		let currentY = 0;

		function onTouchStart(e: TouchEvent) {
			startY = e.touches[0].clientY;
			dragging = false;
			currentY = 0;
			sheet!.style.transition = 'none';
		}

		function onTouchMove(e: TouchEvent) {
			const dy = e.touches[0].clientY - startY;
			currentY = dy;
			if (dy > 0 && body!.scrollTop <= 0) {
				dragging = true;
				e.preventDefault();
				sheet!.style.transform = `translateY(${Math.max(0, dy)}px)`;
			}
		}

		function onTouchEnd() {
			sheet!.style.transition = 'transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)';
			if (dragging && currentY > 80) {
				onClose();
			} else {
				sheet!.style.transform = 'translateY(0)';
			}
			dragging = false;
		}

		sheet.addEventListener('touchstart', onTouchStart, { passive: true });
		sheet.addEventListener('touchmove', onTouchMove, { passive: false });
		sheet.addEventListener('touchend', onTouchEnd, { passive: true });

		return () => {
			sheet.removeEventListener('touchstart', onTouchStart);
			sheet.removeEventListener('touchmove', onTouchMove);
			sheet.removeEventListener('touchend', onTouchEnd);
		};
	}, [isOpen, sheetRef, bodyRef, onClose]);
}
