from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import envelopes, health, inbox, journal, reports

app = FastAPI(title="hledger API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tightened to your Worker domain once deployed
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization"],
)

app.include_router(health.router)
app.include_router(reports.router)
app.include_router(journal.router)
app.include_router(envelopes.router)
app.include_router(inbox.router)
