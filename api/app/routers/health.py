from fastapi import APIRouter, Security

from ..auth import verify_token
from ..version import version_info

router = APIRouter()


@router.get("/health")
def health():
    """No auth — used to verify service is up."""
    return {"status": "ok"}


@router.get("/version")
def version(token: str = Security(verify_token)):
    """The app version and commit this server is running, for the Settings
    screen. Authenticated: the branch name and dirty flag say more about the
    deployment than an unauthenticated liveness probe should."""
    return version_info()
