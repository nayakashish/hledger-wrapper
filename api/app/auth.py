from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import get_settings

security = HTTPBearer()


def verify_token(credentials: HTTPAuthorizationCredentials = Security(security)) -> str:
    settings = get_settings()
    if not settings.bearer_token:
        raise HTTPException(status_code=500, detail="Server misconfigured: BEARER_TOKEN not set")
    if credentials.credentials != settings.bearer_token:
        raise HTTPException(status_code=401, detail="Invalid token")
    return credentials.credentials
