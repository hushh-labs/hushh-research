"""iAlphabets game service — core CRUD and game logic.

Handles leagues, alphabets (26-pick portfolios), draft picks,
weekly swaps, invites, and referral attribution.
"""

from __future__ import annotations

import logging
import secrets
import string
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import text

from db.db_client import get_db_connection

logger = logging.getLogger(__name__)

LETTERS = list(string.ascii_uppercase)
ALLOCATION_PER_SLOT = Decimal("3846.15")
STARTING_CASH = Decimal("100000")
MAX_SWAPS_PER_WEEK = 1


def _generate_code(length: int = 6) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _iso_week_key() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%G-W%V")


@dataclass
class SeasonRow:
    id: str
    slug: str
    starts_at: datetime
    ends_at: datetime
    status: str


@dataclass
class LeagueRow:
    id: str
    season_id: str
    owner_user_id: str
    name: str
    privacy: str
    invite_code: str
    max_members: int
    starting_cash: Decimal
    status: str
    created_at: datetime
    member_count: int = 0


class IalphabetsService:

    # ── Seasons ──────────────────────────────────────────────

    def get_active_season(self) -> Optional[dict]:
        with get_db_connection() as conn:
            row = conn.execute(
                text(
                    "SELECT id, slug, starts_at, ends_at, status "
                    "FROM ialphabets_seasons "
                    "WHERE status IN ('upcoming', 'active') "
                    "ORDER BY starts_at ASC LIMIT 1"
                )
            ).mappings().first()
            if not row:
                return None
            return dict(row)

    def create_season(self, slug: str, starts_at: datetime, ends_at: datetime) -> dict:
        with get_db_connection() as conn:
            row = conn.execute(
                text(
                    "INSERT INTO ialphabets_seasons (slug, starts_at, ends_at, status) "
                    "VALUES (:slug, :starts_at, :ends_at, 'upcoming') "
                    "RETURNING id, slug, starts_at, ends_at, status"
                ),
                {"slug": slug, "starts_at": starts_at, "ends_at": ends_at},
            ).mappings().first()
            return dict(row)

    # ── Leagues ──────────────────────────────────────────────

    def create_league(
        self,
        owner_user_id: str,
        name: str,
        privacy: str = "private",
        max_members: int = 50,
        season_id: Optional[str] = None,
    ) -> dict:
        if not season_id:
            season = self.get_active_season()
            if not season:
                raise ValueError("No active season available")
            season_id = season["id"]

        invite_code = _generate_code()

        with get_db_connection() as conn:
            league = conn.execute(
                text(
                    "INSERT INTO ialphabets_leagues "
                    "(season_id, owner_user_id, name, privacy, invite_code, max_members) "
                    "VALUES (:season_id, :owner, :name, :privacy, :code, :max) "
                    "RETURNING id, season_id, owner_user_id, name, privacy, invite_code, "
                    "max_members, starting_cash, status, created_at"
                ),
                {
                    "season_id": season_id,
                    "owner": owner_user_id,
                    "name": name,
                    "privacy": privacy,
                    "code": invite_code,
                    "max": max_members,
                },
            ).mappings().first()
            league_dict = dict(league)

            conn.execute(
                text(
                    "INSERT INTO ialphabets_league_members (league_id, user_id, display_name) "
                    "VALUES (:league_id, :user_id, :display_name)"
                ),
                {
                    "league_id": league_dict["id"],
                    "user_id": owner_user_id,
                    "display_name": None,
                },
            )
            return league_dict

    def get_league_detail(self, league_id: str, user_id: Optional[str] = None) -> Optional[dict]:
        with get_db_connection() as conn:
            league = conn.execute(
                text(
                    "SELECT l.*, "
                    "(SELECT COUNT(*) FROM ialphabets_league_members m WHERE m.league_id = l.id) AS member_count "
                    "FROM ialphabets_leagues l WHERE l.id = :id"
                ),
                {"id": league_id},
            ).mappings().first()
            if not league:
                return None

            members = conn.execute(
                text(
                    "SELECT m.id, m.user_id, m.display_name, m.joined_at, "
                    "a.status AS alphabet_status, a.total_return_pct, a.rank_in_league, a.current_value "
                    "FROM ialphabets_league_members m "
                    "LEFT JOIN ialphabets_alphabets a ON a.league_id = m.league_id AND a.user_id = m.user_id "
                    "WHERE m.league_id = :id ORDER BY a.rank_in_league ASC NULLS LAST"
                ),
                {"id": league_id},
            ).mappings().all()

            result = dict(league)
            result["members"] = [dict(m) for m in members]

            if user_id:
                my_alpha = conn.execute(
                    text(
                        "SELECT id, status, finalized_at, swaps_used_this_week, "
                        "swaps_week_key, current_value, total_return_pct, rank_in_league "
                        "FROM ialphabets_alphabets WHERE league_id = :lid AND user_id = :uid"
                    ),
                    {"lid": league_id, "uid": user_id},
                ).mappings().first()
                result["my_alphabet"] = dict(my_alpha) if my_alpha else None

            return result

    def list_user_leagues(self, user_id: str) -> list[dict]:
        with get_db_connection() as conn:
            rows = conn.execute(
                text(
                    "SELECT l.*, "
                    "(SELECT COUNT(*) FROM ialphabets_league_members m2 WHERE m2.league_id = l.id) AS member_count "
                    "FROM ialphabets_leagues l "
                    "JOIN ialphabets_league_members m ON m.league_id = l.id "
                    "WHERE m.user_id = :uid ORDER BY l.created_at DESC"
                ),
                {"uid": user_id},
            ).mappings().all()
            return [dict(r) for r in rows]

    def list_public_leagues(self, limit: int = 20, cursor: Optional[str] = None) -> dict:
        with get_db_connection() as conn:
            params: dict[str, Any] = {"limit": limit + 1}
            where = "WHERE l.privacy = 'public' AND l.status IN ('open', 'active')"
            if cursor:
                where += " AND l.created_at < :cursor"
                params["cursor"] = cursor

            rows = conn.execute(
                text(
                    f"SELECT l.*, "
                    f"(SELECT COUNT(*) FROM ialphabets_league_members m WHERE m.league_id = l.id) AS member_count "
                    f"FROM ialphabets_leagues l {where} "
                    f"ORDER BY member_count DESC, l.created_at DESC LIMIT :limit"
                ),
                params,
            ).mappings().all()

            items = [dict(r) for r in rows[:limit]]
            next_cursor = str(items[-1]["created_at"]) if len(rows) > limit else None
            return {"leagues": items, "next_cursor": next_cursor}

    def close_league(self, league_id: str, user_id: str) -> bool:
        with get_db_connection() as conn:
            result = conn.execute(
                text(
                    "UPDATE ialphabets_leagues SET status = 'closed', updated_at = NOW() "
                    "WHERE id = :id AND owner_user_id = :uid AND status != 'closed' "
                    "RETURNING id"
                ),
                {"id": league_id, "uid": user_id},
            ).first()
            return result is not None

    # ── Alphabets (Draft) ─────────────────────────────────────

    def ensure_draft(self, league_id: str, user_id: str) -> dict:
        with get_db_connection() as conn:
            existing = conn.execute(
                text(
                    "SELECT id, status, finalized_at FROM ialphabets_alphabets "
                    "WHERE league_id = :lid AND user_id = :uid"
                ),
                {"lid": league_id, "uid": user_id},
            ).mappings().first()

            if existing:
                alpha = dict(existing)
            else:
                member = conn.execute(
                    text(
                        "SELECT id FROM ialphabets_league_members "
                        "WHERE league_id = :lid AND user_id = :uid"
                    ),
                    {"lid": league_id, "uid": user_id},
                ).mappings().first()
                if not member:
                    raise ValueError("User is not a member of this league")

                row = conn.execute(
                    text(
                        "INSERT INTO ialphabets_alphabets (league_id, user_id) "
                        "VALUES (:lid, :uid) "
                        "RETURNING id, league_id, user_id, status, finalized_at"
                    ),
                    {"lid": league_id, "uid": user_id},
                ).mappings().first()
                alpha = dict(row)

            picks = conn.execute(
                text(
                    "SELECT id, letter, ticker, company_name, cost_basis, shares, "
                    "allocated_cash, locked_at "
                    "FROM ialphabets_picks WHERE alphabet_id = :aid ORDER BY letter"
                ),
                {"aid": alpha["id"]},
            ).mappings().all()
            alpha["picks"] = [dict(p) for p in picks]
            return alpha

    def upsert_draft_pick(self, alphabet_id: str, letter: str, ticker: str, company_name: str = "") -> dict:
        letter = letter.upper().strip()
        ticker = ticker.upper().strip()
        if letter not in LETTERS:
            raise ValueError(f"Invalid letter: {letter}")

        with get_db_connection() as conn:
            alpha = conn.execute(
                text("SELECT status FROM ialphabets_alphabets WHERE id = :id"),
                {"id": alphabet_id},
            ).mappings().first()
            if not alpha or alpha["status"] != "drafting":
                raise ValueError("Alphabet is not in drafting state")

            row = conn.execute(
                text(
                    "INSERT INTO ialphabets_picks (alphabet_id, letter, ticker, company_name, "
                    "cost_basis, shares, allocated_cash) "
                    "VALUES (:aid, :letter, :ticker, :name, 0, 0, :alloc) "
                    "ON CONFLICT (alphabet_id, letter) DO UPDATE SET "
                    "ticker = EXCLUDED.ticker, company_name = EXCLUDED.company_name "
                    "RETURNING id, letter, ticker, company_name, allocated_cash"
                ),
                {
                    "aid": alphabet_id,
                    "letter": letter,
                    "ticker": ticker,
                    "name": company_name,
                    "alloc": float(ALLOCATION_PER_SLOT),
                },
            ).mappings().first()
            return dict(row)

    def finalize_alphabet(self, alphabet_id: str, price_fetcher: Any = None) -> dict:
        """Lock the alphabet: fetch current prices, compute shares for each pick."""
        with get_db_connection() as conn:
            alpha = conn.execute(
                text(
                    "SELECT a.id, a.status, a.league_id, l.starting_cash "
                    "FROM ialphabets_alphabets a "
                    "JOIN ialphabets_leagues l ON l.id = a.league_id "
                    "WHERE a.id = :id"
                ),
                {"id": alphabet_id},
            ).mappings().first()
            if not alpha:
                raise ValueError("Alphabet not found")
            if alpha["status"] != "drafting":
                raise ValueError("Alphabet already finalized")

            picks = conn.execute(
                text(
                    "SELECT id, letter, ticker FROM ialphabets_picks "
                    "WHERE alphabet_id = :aid ORDER BY letter"
                ),
                {"aid": alphabet_id},
            ).mappings().all()

            if len(picks) != 26:
                raise ValueError(f"Must have exactly 26 picks, got {len(picks)}")

            per_slot = Decimal(str(alpha["starting_cash"])) / 26
            now = datetime.now(timezone.utc)

            tickers = [p["ticker"] for p in picks]
            prices = {}
            if price_fetcher:
                for t in tickers:
                    try:
                        data = price_fetcher(t)
                        if data and "price" in data:
                            prices[t] = Decimal(str(data["price"]))
                    except Exception as e:
                        logger.warning("Price fetch failed for %s: %s", t, e)

            total_value = Decimal("0")
            for pick in picks:
                ticker = pick["ticker"]
                price = prices.get(ticker, Decimal("100"))
                shares = per_slot / price if price > 0 else Decimal("0")
                value = shares * price
                total_value += value

                conn.execute(
                    text(
                        "UPDATE ialphabets_picks SET cost_basis = :cost, shares = :shares, "
                        "allocated_cash = :alloc, locked_at = :now "
                        "WHERE id = :id"
                    ),
                    {
                        "id": pick["id"],
                        "cost": float(price),
                        "shares": float(shares),
                        "alloc": float(per_slot),
                        "now": now,
                    },
                )

            conn.execute(
                text(
                    "UPDATE ialphabets_alphabets SET status = 'locked', finalized_at = :now, "
                    "starting_value = :sv, current_value = :sv, updated_at = :now "
                    "WHERE id = :id"
                ),
                {"id": alphabet_id, "now": now, "sv": float(total_value)},
            )

            return {
                "id": alphabet_id,
                "status": "locked",
                "finalized_at": now.isoformat(),
                "starting_value": float(total_value),
            }

    def swap_pick(
        self, alphabet_id: str, letter: str, new_ticker: str, new_company_name: str = "",
        price_fetcher: Any = None,
    ) -> dict:
        letter = letter.upper().strip()
        new_ticker = new_ticker.upper().strip()
        week_key = _iso_week_key()

        with get_db_connection() as conn:
            alpha = conn.execute(
                text(
                    "SELECT id, status, swaps_used_this_week, swaps_week_key "
                    "FROM ialphabets_alphabets WHERE id = :id"
                ),
                {"id": alphabet_id},
            ).mappings().first()

            if not alpha or alpha["status"] != "locked":
                raise ValueError("Alphabet must be locked to swap")

            current_week_key = alpha["swaps_week_key"]
            swaps_used = alpha["swaps_used_this_week"]
            if current_week_key != week_key:
                swaps_used = 0

            if swaps_used >= MAX_SWAPS_PER_WEEK:
                raise ValueError(f"Swap limit reached ({MAX_SWAPS_PER_WEEK}/week)")

            old_pick = conn.execute(
                text(
                    "SELECT id, ticker, allocated_cash FROM ialphabets_picks "
                    "WHERE alphabet_id = :aid AND letter = :letter"
                ),
                {"aid": alphabet_id, "letter": letter},
            ).mappings().first()
            if not old_pick:
                raise ValueError(f"No pick found for letter {letter}")

            new_price = Decimal("100")
            if price_fetcher:
                try:
                    data = price_fetcher(new_ticker)
                    if data and "price" in data:
                        new_price = Decimal(str(data["price"]))
                except Exception:
                    pass

            alloc = Decimal(str(old_pick["allocated_cash"]))
            new_shares = alloc / new_price if new_price > 0 else Decimal("0")
            now = datetime.now(timezone.utc)

            conn.execute(
                text(
                    "UPDATE ialphabets_picks SET ticker = :ticker, company_name = :name, "
                    "cost_basis = :cost, shares = :shares, last_swapped_at = :now "
                    "WHERE id = :id"
                ),
                {
                    "id": old_pick["id"],
                    "ticker": new_ticker,
                    "name": new_company_name,
                    "cost": float(new_price),
                    "shares": float(new_shares),
                    "now": now,
                },
            )

            conn.execute(
                text(
                    "UPDATE ialphabets_alphabets SET swaps_used_this_week = :used, "
                    "swaps_week_key = :wk, updated_at = :now WHERE id = :id"
                ),
                {
                    "id": alphabet_id,
                    "used": swaps_used + 1,
                    "wk": week_key,
                    "now": now,
                },
            )

            return {
                "letter": letter,
                "old_ticker": old_pick["ticker"],
                "new_ticker": new_ticker,
                "swaps_used": swaps_used + 1,
                "swaps_remaining": MAX_SWAPS_PER_WEEK - (swaps_used + 1),
            }

    def get_alphabet_with_picks(self, league_id: str, user_id: str) -> Optional[dict]:
        with get_db_connection() as conn:
            alpha = conn.execute(
                text(
                    "SELECT * FROM ialphabets_alphabets "
                    "WHERE league_id = :lid AND user_id = :uid"
                ),
                {"lid": league_id, "uid": user_id},
            ).mappings().first()
            if not alpha:
                return None

            picks = conn.execute(
                text(
                    "SELECT id, letter, ticker, company_name, cost_basis, shares, "
                    "allocated_cash, locked_at, last_swapped_at "
                    "FROM ialphabets_picks WHERE alphabet_id = :aid ORDER BY letter"
                ),
                {"aid": alpha["id"]},
            ).mappings().all()

            result = dict(alpha)
            result["picks"] = [dict(p) for p in picks]
            return result

    # ── Invites ──────────────────────────────────────────────

    def create_invite(
        self, inviter_user_id: str, league_id: Optional[str] = None, kind: str = "league"
    ) -> dict:
        code = _generate_code()
        with get_db_connection() as conn:
            row = conn.execute(
                text(
                    "INSERT INTO ialphabets_invites (league_id, inviter_user_id, code, kind) "
                    "VALUES (:lid, :uid, :code, :kind) "
                    "RETURNING id, league_id, inviter_user_id, code, kind, created_at"
                ),
                {"lid": league_id, "uid": inviter_user_id, "code": code, "kind": kind},
            ).mappings().first()
            return dict(row)

    def get_invite_preview(self, code: str) -> Optional[dict]:
        with get_db_connection() as conn:
            row = conn.execute(
                text(
                    "SELECT i.id, i.league_id, i.inviter_user_id, i.code, i.kind, "
                    "l.name AS league_name, l.privacy, l.status AS league_status, "
                    "(SELECT COUNT(*) FROM ialphabets_league_members m WHERE m.league_id = l.id) AS member_count, "
                    "l.max_members "
                    "FROM ialphabets_invites i "
                    "LEFT JOIN ialphabets_leagues l ON l.id = i.league_id "
                    "WHERE i.code = :code"
                ),
                {"code": code.upper().strip()},
            ).mappings().first()
            if not row:
                return None
            return dict(row)

    def redeem_invite(self, code: str, redeemer_user_id: str) -> dict:
        code = code.upper().strip()
        with get_db_connection() as conn:
            invite = conn.execute(
                text(
                    "SELECT i.id, i.league_id, i.inviter_user_id, i.max_uses, i.use_count "
                    "FROM ialphabets_invites i WHERE i.code = :code"
                ),
                {"code": code},
            ).mappings().first()

            if not invite:
                raise ValueError("Invalid invite code")
            if invite["max_uses"] and invite["use_count"] >= invite["max_uses"]:
                raise ValueError("Invite has reached max uses")

            league_id = invite["league_id"]
            if not league_id:
                raise ValueError("Invite is not linked to a league")

            league = conn.execute(
                text("SELECT status, max_members FROM ialphabets_leagues WHERE id = :id"),
                {"id": league_id},
            ).mappings().first()
            if not league or league["status"] == "closed":
                raise ValueError("League is closed")

            member_count = conn.execute(
                text(
                    "SELECT COUNT(*) AS cnt FROM ialphabets_league_members WHERE league_id = :lid"
                ),
                {"lid": league_id},
            ).scalar()
            if member_count >= league["max_members"]:
                raise ValueError("League is full")

            existing = conn.execute(
                text(
                    "SELECT id FROM ialphabets_league_members "
                    "WHERE league_id = :lid AND user_id = :uid"
                ),
                {"lid": league_id, "uid": redeemer_user_id},
            ).first()
            if existing:
                raise ValueError("Already a member of this league")

            member = conn.execute(
                text(
                    "INSERT INTO ialphabets_league_members "
                    "(league_id, user_id, joined_via_invite_id) "
                    "VALUES (:lid, :uid, :iid) "
                    "RETURNING id, league_id, user_id, joined_at"
                ),
                {"lid": league_id, "uid": redeemer_user_id, "iid": invite["id"]},
            ).mappings().first()

            conn.execute(
                text(
                    "UPDATE ialphabets_invites SET use_count = use_count + 1 WHERE id = :id"
                ),
                {"id": invite["id"]},
            )

            if invite["inviter_user_id"] != redeemer_user_id:
                conn.execute(
                    text(
                        "INSERT INTO ialphabets_referral_credits "
                        "(invite_id, inviter_user_id, invitee_user_id) "
                        "VALUES (:iid, :inviter, :invitee) "
                        "ON CONFLICT (invite_id, invitee_user_id) DO NOTHING"
                    ),
                    {
                        "iid": invite["id"],
                        "inviter": invite["inviter_user_id"],
                        "invitee": redeemer_user_id,
                    },
                )

            return {"league_id": league_id, "member": dict(member)}

    # ── Leaderboard ──────────────────────────────────────────

    def get_leaderboard(self, league_id: str) -> list[dict]:
        with get_db_connection() as conn:
            rows = conn.execute(
                text(
                    "SELECT a.user_id, m.display_name, a.total_return_pct, "
                    "a.current_value, a.rank_in_league, a.status "
                    "FROM ialphabets_alphabets a "
                    "JOIN ialphabets_league_members m ON m.league_id = a.league_id AND m.user_id = a.user_id "
                    "WHERE a.league_id = :lid AND a.status IN ('locked', 'closed') "
                    "ORDER BY a.rank_in_league ASC NULLS LAST"
                ),
                {"lid": league_id},
            ).mappings().all()
            return [dict(r) for r in rows]

    def get_leaderboard_history(self, league_id: str) -> list[dict]:
        with get_db_connection() as conn:
            rows = conn.execute(
                text(
                    "SELECT s.alphabet_id, a.user_id, s.as_of_date, "
                    "s.total_value, s.return_pct, s.rank_in_league "
                    "FROM ialphabets_snapshots s "
                    "JOIN ialphabets_alphabets a ON a.id = s.alphabet_id "
                    "WHERE s.league_id = :lid "
                    "ORDER BY s.as_of_date ASC, s.rank_in_league ASC"
                ),
                {"lid": league_id},
            ).mappings().all()

            by_user: dict[str, list[dict]] = {}
            for r in rows:
                uid = r["user_id"]
                if uid not in by_user:
                    by_user[uid] = []
                by_user[uid].append(
                    {
                        "date": str(r["as_of_date"]),
                        "value": float(r["total_value"]),
                        "return_pct": float(r["return_pct"]),
                        "rank": r["rank_in_league"],
                    }
                )
            return [{"user_id": uid, "points": pts} for uid, pts in by_user.items()]

    # ── Ticker search (delegates to TickerCache) ─────────────

    def search_tickers_by_letter(self, letter: str, q: str = "", limit: int = 25) -> list[dict]:
        from hushh_mcp.services.ticker_cache import ticker_cache

        return ticker_cache.search_by_letter(letter, q, limit)
