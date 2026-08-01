from pydantic import BaseModel, Field

from .config import get_settings


class Transaction(BaseModel):
    date: str | None = None        # YYYY-MM-DD
    description: str | None = None
    account1: str | None = None
    amount1: float | None = None
    account2: str | None = None
    amount2: float | None = None   # auto-calculated if omitted
    currency: str = Field(default_factory=lambda: get_settings().default_currency)
    raw_entry: str | None = None   # if set, written directly (supports comments)


class Assignment(BaseModel):
    txn_id: str
    # For expenses: single envelope drain
    envelope_id: str | None = None
    # For income: list of {envelope_id, amount} splits
    splits: list | None = None
    note: str | None = None


class EnvTransfer(BaseModel):
    from_envelope: str
    to_envelope: str
    amount: float
    note: str | None = None


class EnvAdjust(BaseModel):
    envelope: str
    amount: float
    note: str | None = None


class EnvCreate(BaseModel):
    name: str
    parent: str | None = None


class InboxIngest(BaseModel):
    amount: float
    merchant: str
    card_last4: str = ""
    txn_date: str = ""
    email_message_id: str = ""
    raw_subject: str = ""
    bank: str = ""
    parsed: bool = True


class InboxPostBody(BaseModel):
    id: str
    raw_entry: str | None = None


class InboxDismissBody(BaseModel):
    id: str


class InboxRuleBody(BaseModel):
    pattern: str
    account: str
    description: str
