import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';

export interface ToastAction {
	label: string;
	onClick: () => void;
}

interface Props {
	message: string;
	visible: boolean;
	action?: ToastAction | null;
	onDismiss?: () => void;
}

interface Drag {
	id: number;
	x: number;
	y: number;
	t: number;
	dx: number;
	dy: number;
	active: boolean;
}

// Movement before a press counts as a drag, so a tap on the action still
// registers as a tap.
const DRAG_START_PX = 6;
// How far a release has to travel to dismiss: a short pull down, or a longer
// sideways swipe. A quick flick dismisses regardless of distance.
const DISMISS_DOWN_PX = 36;
const DISMISS_SIDE_PX = 80;
const FLICK_PX_PER_MS = 0.5;

export default function Toast({ message, visible, action, onDismiss }: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const drag = useRef<Drag | null>(null);
	const suppressClick = useRef(false);

	// A newly shown toast starts from its resting place, even if the last one
	// was swiped away and still carries the inline styles from leaving.
	useEffect(() => {
		const el = ref.current;
		if (!visible || !el) return;
		el.style.transition = '';
		el.style.transform = '';
		el.style.opacity = '';
	}, [visible, message]);

	const swipeable = visible && !!onDismiss;

	function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
		if (!swipeable) return;
		drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, dx: 0, dy: 0, active: false };
	}

	function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
		const d = drag.current;
		const el = ref.current;
		if (!d || !el || e.pointerId !== d.id) return;
		d.dx = e.clientX - d.x;
		d.dy = Math.max(0, e.clientY - d.y); // down or sideways only
		if (!d.active) {
			if (Math.hypot(d.dx, d.dy) < DRAG_START_PX) return;
			d.active = true;
			el.setPointerCapture(e.pointerId);
			el.style.transition = 'none';
		}
		const progress = Math.max(Math.abs(d.dx) / (DISMISS_SIDE_PX * 2), d.dy / (DISMISS_DOWN_PX * 2));
		el.style.transform = `translateX(calc(-50% + ${d.dx}px)) translateY(${d.dy}px)`;
		el.style.opacity = String(Math.max(0.25, 1 - progress));
	}

	function onPointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
		const d = drag.current;
		const el = ref.current;
		drag.current = null;
		if (!d || !el || !d.active || e.pointerId !== d.id) return;

		// The release ends a drag, so the click that follows it must not
		// trigger the action underneath.
		suppressClick.current = true;
		setTimeout(() => { suppressClick.current = false; }, 0);

		const speed = Math.hypot(d.dx, d.dy) / Math.max(1, e.timeStamp - d.t);
		const away = d.dy > DISMISS_DOWN_PX || Math.abs(d.dx) > DISMISS_SIDE_PX || speed > FLICK_PX_PER_MS;
		el.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
		if (away && onDismiss) {
			const sideways = Math.abs(d.dx) > d.dy;
			el.style.transform = sideways
				? `translateX(calc(-50% + ${Math.sign(d.dx) * 420}px)) translateY(${d.dy}px)`
				: `translateX(calc(-50% + ${d.dx}px)) translateY(${d.dy + 120}px)`;
			el.style.opacity = '0';
			onDismiss();
		} else {
			el.style.transform = '';
			el.style.opacity = '';
		}
	}

	function onClickCapture(e: ReactMouseEvent<HTMLDivElement>) {
		if (suppressClick.current) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	return (
		<div
			ref={ref}
			className={`toast${visible ? ' show' : ''}${action ? ' has-action' : ''}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
			onClickCapture={onClickCapture}
		>
			{message}
			{action && (
				<button type="button" className="toast-action" onClick={action.onClick}>
					{action.label}
				</button>
			)}
		</div>
	);
}
