import os

from fastapi import APIRouter, Security

from ..auth import verify_token
from ..config import get_settings
from ..prediction import load_transactions
from ..presets import resolve_all
from ..storage import load_json

router = APIRouter()


def load_stored_presets(path: str | None = None) -> dict:
    """The remembered resolutions, keyed by preset id. Absent or unreadable is
    normal — it only ever supplements inference, so an empty dict is a
    perfectly good answer."""
    path = path if path is not None else get_settings().presets_data_file
    if not path or not os.path.exists(path):
        return {}
    try:
        return load_json(path).get("resolved", {})
    except (OSError, ValueError):
        return {}


@router.get("/presets")
def get_presets(token: str = Security(verify_token)):
    """The add-transaction presets with their accounts and titles filled in
    from this journal. One journal scan covers all of them."""
    return {"presets": resolve_all(load_transactions(), load_stored_presets())}
