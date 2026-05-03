"""iAlphabets scoring service — daily EOD snapshots and season rollover."""

from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Optional

from sqlalchemy import text

from db.db_client import get_db_connection

logger = logging.getLogger(__name__)


class IalphabetsScoringService:

    async def run_daily_snapshot(
        self,
        as_of_date: date,
        price_fetcher: Optional[Callable] = None,
    ) -> dict:
        """Compute EOD portfolio values and write snapshot rows.

        Steps:
        1. Fetch all locked alphabets with their 26 picks
        2. Collect unique tickers, bulk-fetch prices
        3. Compute total value per alphabet
        4. Write snapshot rows
        5. Recompute rank_in_league via DENSE_RANK
        """
        with get_db_connection() as conn:
            alphabets = conn.execute(
                text(
                    "SELECT a.id AS alphabet_id, a.league_id, a.starting_value, a.user_id "
                    "FROM ialphabets_alphabets a "
                    "JOIN ialphabets_leagues l ON l.id = a.league_id "
                    "WHERE a.status = 'locked' AND l.status IN ('open', 'active', 'drafting')"
                )
            ).mappings().all()

            if not alphabets:
                return {"processed": 0, "leagues_updated": 0, "errors": []}

            alpha_ids = [a["alphabet_id"] for a in alphabets]
            placeholders = ", ".join(f":a{i}" for i in range(len(alpha_ids)))
            params = {f"a{i}": aid for i, aid in enumerate(alpha_ids)}

            picks = conn.execute(
                text(
                    f"SELECT alphabet_id, letter, ticker, shares "
                    f"FROM ialphabets_picks WHERE alphabet_id IN ({placeholders})"
                ),
                params,
            ).mappings().all()

            unique_tickers = list({p["ticker"] for p in picks})

            prices: dict[str, Decimal] = {}
            if price_fetcher:
                sem = asyncio.Semaphore(8)

                async def _fetch(ticker: str) -> None:
                    async with sem:
                        try:
                            data = await asyncio.to_thread(price_fetcher, ticker)
                            if data and "price" in data:
                                prices[ticker] = Decimal(str(data["price"]))
                        except Exception as e:
                            logger.warning("Price fetch failed for %s: %s", ticker, e)

                await asyncio.gather(*[_fetch(t) for t in unique_tickers])

            picks_by_alpha: dict[str, list] = {}
            for p in picks:
                picks_by_alpha.setdefault(p["alphabet_id"], []).append(p)

            errors: list[str] = []
            league_ids_updated: set[str] = set()

            for alpha in alphabets:
                aid = alpha["alphabet_id"]
                alpha_picks = picks_by_alpha.get(aid, [])
                starting = Decimal(str(alpha["starting_value"]))

                total = Decimal("0")
                breakdown: dict[str, dict] = {}
                for p in alpha_picks:
                    ticker = p["ticker"]
                    shares = Decimal(str(p["shares"]))
                    price = prices.get(ticker)
                    if price is None:
                        last = conn.execute(
                            text(
                                "SELECT price_breakdown->:ticker->>'price' AS last_price "
                                "FROM ialphabets_snapshots "
                                "WHERE alphabet_id = :aid ORDER BY as_of_date DESC LIMIT 1"
                            ),
                            {"ticker": ticker, "aid": aid},
                        ).mappings().first()
                        if last and last["last_price"]:
                            price = Decimal(last["last_price"])
                        else:
                            price = Decimal("0")
                            errors.append(f"No price for {ticker} in alphabet {aid}")

                    val = shares * price
                    total += val
                    breakdown[p["letter"]] = {"ticker": ticker, "price": float(price)}

                return_pct = ((total - starting) / starting * 100) if starting > 0 else Decimal("0")

                try:
                    conn.execute(
                        text(
                            "INSERT INTO ialphabets_snapshots "
                            "(alphabet_id, league_id, as_of_date, total_value, return_pct, price_breakdown) "
                            "VALUES (:aid, :lid, :d, :val, :ret, :bd) "
                            "ON CONFLICT (alphabet_id, as_of_date) DO UPDATE SET "
                            "total_value = EXCLUDED.total_value, return_pct = EXCLUDED.return_pct, "
                            "price_breakdown = EXCLUDED.price_breakdown"
                        ),
                        {
                            "aid": aid,
                            "lid": alpha["league_id"],
                            "d": as_of_date,
                            "val": float(total),
                            "ret": float(return_pct),
                            "bd": {k: v for k, v in breakdown.items()},
                        },
                    )

                    conn.execute(
                        text(
                            "UPDATE ialphabets_alphabets SET current_value = :val, "
                            "total_return_pct = :ret, updated_at = NOW() WHERE id = :id"
                        ),
                        {"val": float(total), "ret": float(return_pct), "id": aid},
                    )
                    league_ids_updated.add(alpha["league_id"])
                except Exception as e:
                    errors.append(f"Snapshot write failed for {aid}: {e}")

            for lid in league_ids_updated:
                try:
                    conn.execute(
                        text(
                            "UPDATE ialphabets_alphabets SET rank_in_league = sub.rnk "
                            "FROM ("
                            "  SELECT id, DENSE_RANK() OVER (ORDER BY total_return_pct DESC) AS rnk "
                            "  FROM ialphabets_alphabets "
                            "  WHERE league_id = :lid AND status = 'locked'"
                            ") sub WHERE ialphabets_alphabets.id = sub.id"
                        ),
                        {"lid": lid},
                    )

                    conn.execute(
                        text(
                            "UPDATE ialphabets_snapshots SET rank_in_league = a.rank_in_league "
                            "FROM ialphabets_alphabets a "
                            "WHERE ialphabets_snapshots.alphabet_id = a.id "
                            "AND ialphabets_snapshots.as_of_date = :d AND ialphabets_snapshots.league_id = :lid"
                        ),
                        {"lid": lid, "d": as_of_date},
                    )
                except Exception as e:
                    errors.append(f"Rank update failed for league {lid}: {e}")

            return {
                "processed": len(alphabets),
                "leagues_updated": len(league_ids_updated),
                "errors": errors,
            }

    def rollover_seasons(self) -> dict:
        """Close expired seasons, create the next one if needed."""
        now = datetime.now(timezone.utc)
        with get_db_connection() as conn:
            closed = conn.execute(
                text(
                    "UPDATE ialphabets_seasons SET status = 'closed' "
                    "WHERE status = 'active' AND ends_at <= :now RETURNING id, slug"
                ),
                {"now": now},
            ).mappings().all()

            activated = conn.execute(
                text(
                    "UPDATE ialphabets_seasons SET status = 'active' "
                    "WHERE status = 'upcoming' AND starts_at <= :now AND ends_at > :now "
                    "RETURNING id, slug"
                ),
                {"now": now},
            ).mappings().all()

            if closed:
                closed_ids = [c["id"] for c in closed]
                placeholders = ", ".join(f":c{i}" for i in range(len(closed_ids)))
                params = {f"c{i}": cid for i, cid in enumerate(closed_ids)}
                conn.execute(
                    text(
                        f"UPDATE ialphabets_leagues SET status = 'closed', updated_at = NOW() "
                        f"WHERE season_id IN ({placeholders}) AND status != 'closed'"
                    ),
                    params,
                )
                conn.execute(
                    text(
                        f"UPDATE ialphabets_alphabets SET status = 'closed', updated_at = NOW() "
                        f"FROM ialphabets_leagues l "
                        f"WHERE ialphabets_alphabets.league_id = l.id "
                        f"AND l.season_id IN ({placeholders}) AND ialphabets_alphabets.status != 'closed'"
                    ),
                    params,
                )

            active_or_upcoming = conn.execute(
                text(
                    "SELECT id FROM ialphabets_seasons "
                    "WHERE status IN ('active', 'upcoming') LIMIT 1"
                )
            ).first()
            new_season = None
            if not active_or_upcoming:
                next_start = now + timedelta(days=1)
                next_start = next_start.replace(hour=0, minute=0, second=0, microsecond=0)
                next_end = next_start + timedelta(days=28)
                iso = next_start.isocalendar()
                slug = f"{iso.year}-s{(iso.week // 4) + 1:02d}"
                new_season = conn.execute(
                    text(
                        "INSERT INTO ialphabets_seasons (slug, starts_at, ends_at, status) "
                        "VALUES (:slug, :start, :end, 'upcoming') "
                        "ON CONFLICT (slug) DO NOTHING "
                        "RETURNING id, slug, starts_at, ends_at"
                    ),
                    {"slug": slug, "start": next_start, "end": next_end},
                ).mappings().first()

            return {
                "closed_seasons": [dict(c) for c in closed],
                "activated_seasons": [dict(a) for a in activated],
                "new_season": dict(new_season) if new_season else None,
            }

    def compute_leaderboard(self, league_id: str) -> list[dict]:
        with get_db_connection() as conn:
            rows = conn.execute(
                text(
                    "SELECT a.user_id, m.display_name, a.total_return_pct, "
                    "a.current_value, a.rank_in_league "
                    "FROM ialphabets_alphabets a "
                    "JOIN ialphabets_league_members m "
                    "  ON m.league_id = a.league_id AND m.user_id = a.user_id "
                    "WHERE a.league_id = :lid AND a.status IN ('locked', 'closed') "
                    "ORDER BY a.rank_in_league ASC NULLS LAST"
                ),
                {"lid": league_id},
            ).mappings().all()
            return [dict(r) for r in rows]
