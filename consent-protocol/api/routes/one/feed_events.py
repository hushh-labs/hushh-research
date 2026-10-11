"""Token-scoped document-feed stream for the web app.

GET /api/one/feed/events?v=2

The owner comes from the verified Firebase ID token, never from the URL. Frames
match /api/consent/document-feed/{user_id}?v=2. Admission is bounded per worker
so streams can never starve ordinary API requests.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/one/feed", tags=["Feed"])
