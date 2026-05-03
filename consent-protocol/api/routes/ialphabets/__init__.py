"""iAlphabets API Routes — Stock Trading Game

Modules:
- leagues: League CRUD, seasons, public/private management
- alphabets: Draft picks, finalization, swaps, ticker search
- leaderboard: Rankings and history
- invites: Invite codes, redemption, referral credits
- scoring: Internal-only daily snapshot and season rollover
"""

from fastapi import APIRouter

from .alphabets import router as alphabets_router
from .invites import router as invites_router
from .leaderboard import router as leaderboard_router
from .leagues import router as leagues_router
from .scoring import router as scoring_router

ialphabets_router = APIRouter(prefix="/api/ialphabets", tags=["ialphabets"])

ialphabets_router.include_router(leagues_router)
ialphabets_router.include_router(alphabets_router)
ialphabets_router.include_router(leaderboard_router)
ialphabets_router.include_router(invites_router)
ialphabets_router.include_router(scoring_router)

router = ialphabets_router
