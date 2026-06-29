import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

interface PrivacyContextValue {
	privacyMode: boolean;
	togglePrivacy: () => void;
}

const PrivacyContext = createContext<PrivacyContextValue>({
	privacyMode: false,
	togglePrivacy: () => {},
});

export function PrivacyProvider({ children }: { children: ReactNode }) {
	const [privacyMode, setPrivacyMode] = useState(false);
	const togglePrivacy = () => setPrivacyMode(v => !v);
	return (
		<PrivacyContext.Provider value={{ privacyMode, togglePrivacy }}>
			{children}
		</PrivacyContext.Provider>
	);
}

export function usePrivacy() {
	return useContext(PrivacyContext);
}
