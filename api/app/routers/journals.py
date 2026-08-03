import os

from fastapi import APIRouter, HTTPException, Security

from ..auth import verify_token
from ..config import (
    active_journal_name,
    get_settings,
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


@router.get("/journals")
def get_journals(token: str = Security(verify_token)):
    """List selectable journals (subfolders of JOURNAL_DIR holding a matching
    <name>.journal), flagging the active one."""
    active = active_journal_name()
    names = list_journals(get_settings().journal_dir)
    return {"journals": [{"name": n, "active": n == active} for n in names]}


@router.post("/journals/select")
def select_journal(body: JournalSelect, token: str = Security(verify_token)):
    """Switch the active journal. Validates the name against the discovered
    journals (whitelist — never trusts a client-supplied path), seeds the
    journal's envelopes/inbox stores if absent, then persists the selection."""
    journal_dir = get_settings().journal_dir
    if body.name not in list_journals(journal_dir):
        raise HTTPException(status_code=400, detail=f"Unknown journal: {body.name}")

    paths = journal_paths(journal_dir, body.name)
    # Seed sidecar stores so the envelope/inbox endpoints work on a fresh
    # journal instead of 503-ing on a missing file.
    if not os.path.exists(paths["envelope_data_file"]):
        save_json(paths["envelope_data_file"], _default_env_data())
    if not os.path.exists(paths["inbox_data_file"]):
        save_json(paths["inbox_data_file"], _default_inbox_data())

    config = load_app_config()
    config["active_journal"] = body.name
    save_app_config(config)
    return {"status": "ok", "active_journal": body.name}
