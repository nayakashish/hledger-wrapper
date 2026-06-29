import { usePrivacy } from '../context/PrivacyContext';
import { fmtAmount } from '../utils/format';

interface Props {
	value: number;
	commodity?: string;
	className?: string;
}

export default function MaskedAmount({ value, commodity = '$', className }: Props) {
	const { privacyMode } = usePrivacy();
	return (
		<span className={className}>
			{privacyMode ? '••••' : fmtAmount(value, commodity)}
		</span>
	);
}
