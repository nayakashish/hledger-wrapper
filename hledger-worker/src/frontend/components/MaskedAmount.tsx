import { usePrivacy } from '../context/PrivacyContext';
import { fmtAmount } from '../utils/format';

interface Props {
	value: number;
	commodity?: string;
	className?: string;
	prefix?: string;
}

export default function MaskedAmount({ value, commodity = '$', className, prefix = '' }: Props) {
	const { privacyMode } = usePrivacy();
	return (
		<span className={className}>
			{prefix}
			{privacyMode ? '••••' : fmtAmount(value, commodity)}
		</span>
	);
}
