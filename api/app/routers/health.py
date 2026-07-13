from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def health():
    """No auth — used to verify service is up."""
    return {"status": "ok"}
