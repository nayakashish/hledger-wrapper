import { usePrivacy } from '../context/PrivacyContext';

interface Props {
	inboxPending: boolean;
	onInboxOpen: () => void;
}

export default function Header({ inboxPending, onInboxOpen }: Props) {
	const { privacyMode, togglePrivacy } = usePrivacy();

	return (
		<header>
			<h1>hledger <span>— nayakashish</span></h1>
			<div className="header-actions">
				<button
					className={`privacy-toggle inbox-toggle${inboxPending ? ' has-pending' : ''}`}
					onClick={onInboxOpen}
					aria-label={inboxPending ? 'Open inbox (pending transactions)' : 'Open inbox'}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
						<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
					</svg>
				</button>
				<button
					className="privacy-toggle"
					onClick={togglePrivacy}
					aria-label={privacyMode ? 'Show amounts' : 'Hide amounts'}
				>
					{privacyMode ? (
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
							<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
							<line x1="1" y1="1" x2="23" y2="23"/>
						</svg>
					) : (
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
							<circle cx="12" cy="12" r="3"/>
						</svg>
					)}
				</button>
			</div>
		</header>
	);
}
