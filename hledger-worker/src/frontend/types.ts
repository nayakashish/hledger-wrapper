export interface AmountQuantity {
	decimalMantissa: number;
	decimalPlaces: number;
}

export interface Amount {
	aquantity: number | AmountQuantity;
	acommodity: string;
}

export interface Posting {
	paccount: string;
	pamount: Amount[];
	pcomment?: string;
}

export interface Transaction {
	tdate: string;
	tdescription: string;
	tpayee?: string;
	tcomment?: string;
	tpostings: Posting[];
}

export interface BalanceRow {
	// [accountName, indent, total, amounts[]]
	0: string;
	1: number;
	2: Amount[];
	3: Amount[];
}

export interface PeriodicRow {
	prrName: string;
	prrAmounts: Amount[][];
}

export interface DateRange {
	contents?: string;
}

export interface MonthlyData {
	prRows: PeriodicRow[];
	prDates: [DateRange, DateRange][];
}

export interface Envelope {
	id: string;
	name: string;
	parent?: string | null;
	sort_order?: number;
}

export interface PendingTxn {
	txn_id: string;
	date: string;
	description: string;
	amount: number;
	type: 'income' | 'expense';
	accounts: string[];
	suggested_envelope?: string;
}

export interface HistoryEntry {
	envelope: string;
	amount: number;
	date: string;
	note?: string;
	type: string;
	txn_id?: string;
}

export interface IncomeSplitDefault {
	tithe_pct?: number;
	savings?: number;
}

export interface EnvelopeData {
	envelopes: Envelope[];
	balances: Record<string, number>;
	pending: PendingTxn[];
	history: HistoryEntry[];
	income_split_default?: IncomeSplitDefault;
}

export interface DailyTotal {
	date: string;
	count: number;
	total: number;
}

export type ViewName = 'dashboard' | 'envelopes' | 'transactions' | 'reports';

export interface AppCache {
	balance?: BalanceRow[][];
	is?: unknown;
	monthly?: MonthlyData;
	transactions?: Transaction[];
	envelopes?: EnvelopeData;
}

export interface AddFormState {
	date?: string;
	description?: string;
	account1?: string;
	amount1?: number;
	account2?: string;
	amount2?: number;
	_predicted?: PredictedPosting | null;
	_amount2edited?: boolean;
}

export interface PredictedPosting {
	account1?: string;
	account2?: string;
	amount1?: number;
	amount2?: number;
}

export type DetailContent =
	| { kind: 'transaction'; txn: Transaction }
	| { kind: 'envelope'; envId: string }
	| { kind: 'new-envelope' };

export interface InboxSuggestion {
	description: string;
	account1: string;
	amount1: number;
	account2: string;
	amount2: number;
	confidence: 'high' | 'medium' | 'low';
	matched_on: string;
}

export interface InboxJournalMatch {
	date: string;
	description: string;
}

export interface InboxItem {
	id: string;
	source: string;
	received_at: string;
	txn_date: string;
	amount: number;
	currency: string;
	merchant_raw: string;
	merchant_clean: string;
	card_last4: string;
	raw_subject?: string;
	bank?: string;
	parsed?: boolean;
	suggestion: InboxSuggestion;
	journal_match?: InboxJournalMatch | null;
}

export interface InboxResponse {
	items: InboxItem[];
	pending: number;
}

export interface InboxRule {
	pattern: string;
	account: string;
	description: string;
}
