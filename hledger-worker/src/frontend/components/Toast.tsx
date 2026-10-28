export interface ToastAction {
	label: string;
	onClick: () => void;
}

interface Props {
	message: string;
	visible: boolean;
	action?: ToastAction | null;
}

export default function Toast({ message, visible, action }: Props) {
	return (
		<div className={`toast${visible ? ' show' : ''}${action ? ' has-action' : ''}`}>
			{message}
			{action && (
				<button type="button" className="toast-action" onClick={action.onClick}>
					{action.label}
				</button>
			)}
		</div>
	);
}
