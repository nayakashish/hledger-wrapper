from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import envelopes, health, inbox, journal, journals, presets, reports
from .version import project_version

# One version for the whole project, read from package.json (see app/version.py)
# so this never becomes a second copy that drifts.
app = FastAPI(title="hledger API", version=project_version() or "0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tightened to your Worker domain once deployed
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization"],
)

app.include_router(health.router)
app.include_router(reports.router)
app.include_router(journal.router)
app.include_router(journals.router)
app.include_router(presets.router)
app.include_router(envelopes.router)
app.include_router(inbox.router)
