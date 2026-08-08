import os

from fastapi import APIRouter, HTTPException, Security

from ..auth import verify_token
from ..config import (
    active_journal_name,
    get_settings,
    inbox_journal_name,
    is_demo_journal,
    journal_paths,
    list_journals,
    load_app_config,
    save_app_config,
)
from ..models import JournalSelect
from ..storage import save_json
from .envelopes import _default_env_data
from .inbox import _default_inbox_data

router = APIRouter()


def _seed_sidecars_if_missing(paths: dict) -> None:
    """Seed sidecar stores so the envelope/inbox endpoints work on a fresh
    journal instead of 503-ing on a missing file."""
    if not os.path.exists(paths["envelope_data_file"]):
        save_json(paths["envelope_data_file"], _default_env_data())
    if not os.path.exists(paths["inbox_data_file"]):
        save_json(paths["inbox_data_file"], _default_inbox_data())


@router.get("/journals")
def get_journals(token: str = Security(verify_token)):
    """List selectable journals (subfolders of JOURNAL_DIR holding a matching
    <name>.journal), flagging which is active for viewing, which is the
    email-ingest target, and which (if any) is the demo journal — the demo
    is a normal journal for viewing but is never a valid ingest target."""
    active = active_journal_name()
    inbox = inbox_journal_name()
    names = list_journals(get_settings().journal_dir)
    return {
        "journals": [
            {"name": n, "active": n == active, "inbox": n == inbox, "demo": is_demo_journal(n)}
            for n in names
        ]
    }


@router.post("/journals/select")
def select_journal(body: JournalSelect, token: str = Security(verify_token)):
    """Switch the active (viewed) journal. Validates the name against the
    discovered journals (whitelist — never trusts a client-supplied path),
    seeds the journal's envelopes/inbox stores if absent, then persists the
    selection. The demo journal is a normal pick here — this only controls
    what you're viewing, not where email alerts land."""
    journal_dir = get_settings().journal_dir
    if body.name not in list_journals(journal_dir):
        raise HTTPException(status_code=400, detail=f"Unknown journal: {body.name}")

    _seed_sidecars_if_missing(journal_paths(journal_dir, body.name))

    config = load_app_config()
    config["active_journal"] = body.name
    save_app_config(config)
    return {"status": "ok", "active_journal": body.name}


@router.post("/journals/select-inbox")
def select_inbox_journal(body: JournalSelect, token: str = Security(verify_token)):
    """Set the journal inbound bank-alert emails are routed to, independent
    of active_journal — switching what you're viewing never changes this.
    Rejects the demo journal: it must never be a real ingest target."""
    journal_dir = get_settings().journal_dir
    if body.name not in list_journals(journal_dir):
        raise HTTPException(status_code=400, detail=f"Unknown journal: {body.name}")
    if is_demo_journal(body.name):
        raise HTTPException(status_code=400, detail="The demo journal cannot be an inbox target")

    _seed_sidecars_if_missing(journal_paths(journal_dir, body.name))

    config = load_app_config()
    config["inbox_journal"] = body.name
    save_app_config(config)
    return {"status": "ok", "inbox_journal": body.name}
