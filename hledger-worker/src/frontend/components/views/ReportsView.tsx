import { useState } from 'react';
import BalanceView from './BalanceView';
import MonthlyView from './MonthlyView';
import CoAView from './CoAView';
import type { BalanceRow, MonthlyData, Transaction } from '../../types';

type ReportTab = 'balance' | 'monthly' | 'coa';

interface Props {
	balance: BalanceRow[][] | null;
	monthly: MonthlyData | null;
	accounts: string[];
	isActive: boolean;
	onTxnClick: (txn: Transaction) => void;
}

export default function ReportsView({ balance, monthly, accounts, isActive, onTxnClick }: Props) {
	const [tab, setTab] = useState<ReportTab>('balance');

	return (
		<div className={`view${isActive ? ' active' : ''}`} id="view-reports">
			<div className="report-tab-bar">
				<button
					className={`report-tab${tab === 'balance' ? ' active' : ''}`}
					onClick={() => setTab('balance')}
				>
					Balance
				</button>
				<button
					className={`report-tab${tab === 'monthly' ? ' active' : ''}`}
					onClick={() => setTab('monthly')}
				>
					Monthly
				</button>
				<button
					className={`report-tab${tab === 'coa' ? ' active' : ''}`}
					onClick={() => setTab('coa')}
				>
					Accounts
				</button>
			</div>
			<BalanceView data={balance} isActive={tab === 'balance'} onTxnClick={onTxnClick} />
			<MonthlyView data={monthly} isActive={tab === 'monthly'} onTxnClick={onTxnClick} />
			<CoAView accounts={accounts} isActive={tab === 'coa'} />
		</div>
	);
}
