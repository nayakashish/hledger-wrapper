import { extractAmount, amountClass } from '../utils/format';
import type { BalanceRow } from '../types';
import MaskedAmount from './MaskedAmount';

interface Props {
	balance: BalanceRow[][] | null;
}

export default function SummaryCards({ balance }: Props) {
	if (!balance) return null;

	const rows = Array.isArray(balance[0]) ? balance[0] : [];
	let assets = 0;
	let liabilities = 0;
	let commodity = '$';

	rows.forEach(row => {
		const name = row[0];
		const amounts = row[3];
		const { val, commodity: com } = extractAmount(amounts);
		commodity = com || commodity;
		if (name.startsWith('assets')) assets += val;
		if (name.startsWith('liabilities')) liabilities += val;
	});

	const net = assets + liabilities;

	return (
		<div className="summary-cards">
			<div className="summary-card">
				<div className="card-label">Assets</div>
				<div className="card-value amount-positive">
					<MaskedAmount value={assets} commodity={commodity} />
				</div>
			</div>
			<div className="summary-card">
				<div className="card-label">Liabilities</div>
				<div className="card-value amount-negative">
					<MaskedAmount value={Math.abs(liabilities)} commodity={commodity} />
				</div>
			</div>
			<div className="summary-card">
				<div className="card-label">Net Worth</div>
				<div className={`card-value ${amountClass(net)}`}>
					<MaskedAmount value={net} commodity={commodity} />
				</div>
			</div>
		</div>
	);
}
