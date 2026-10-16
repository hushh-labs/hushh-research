"""Postgres authority for domain decisions, shared budgets and single-use codes."""

from __future__ import annotations

import hmac
import json
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from hushh_mcp.services.email_auth.contracts import (
    MAX_ATTEMPTS,
    POLICY_VERSION,
    DomainDecision,
    EmailAuthError,
)


class PostgresEmailAuthStore:
    def __init__(self, pool):
        self.pool = pool

    @staticmethod
    async def _active_policy(conn, risk_version: str) -> None:
        policy = await conn.fetchrow(
            "SELECT * FROM email_auth_policy_state WHERE singleton FOR SHARE"
        )
        if not policy or (policy["policy_version"], policy["risk_version"]) != (
            POLICY_VERSION,
            risk_version,
        ):
            raise EmailAuthError("policy_unavailable", "Domain checks are unavailable.", 503)

    @staticmethod
    async def _budget(conn, key: str, limit: int, seconds: int) -> bool:
        row = await conn.fetchrow(
            """INSERT INTO email_auth_budgets(budget_key,count,expires_at)
               VALUES ($1,1,clock_timestamp()+$3*INTERVAL '1 second')
               ON CONFLICT(budget_key) DO UPDATE SET
                 count=CASE WHEN email_auth_budgets.expires_at<=clock_timestamp()
                       THEN 1 ELSE email_auth_budgets.count+1 END,
                 expires_at=CASE WHEN email_auth_budgets.expires_at<=clock_timestamp()
                       THEN EXCLUDED.expires_at ELSE email_auth_budgets.expires_at END
               WHERE email_auth_budgets.expires_at<=clock_timestamp()
                  OR email_auth_budgets.count<$2 RETURNING count""",
            key,
            limit,
            seconds,
        )
        return row is not None

    async def discovery_budget(self, client_hash: str, domain: str) -> None:
        allowed = True
        async with self.pool.acquire() as conn, conn.transaction():
            for key, limit in [
                ("discover:client:" + client_hash, 30),
                ("discover:domain:" + domain, 60),
                ("discover:global", 600),
            ]:
                if not await self._budget(conn, key, limit, 60):
                    allowed = False
                    break
        if not allowed:
            raise EmailAuthError("rate_limited", "Wait a minute before trying again.", 429)

    async def claim_review(self, domain: str, risk_version: str, review_id: str):
        async with self.pool.acquire() as conn, conn.transaction():
            await self._active_policy(conn, risk_version)
            await conn.execute(
                """INSERT INTO email_auth_domain_decisions
                   (domain,status,reason,policy_version,risk_version,expires_at)
                   VALUES ($1,'pending','not_evaluated',$2,$3,clock_timestamp())
                   ON CONFLICT(domain) DO NOTHING""",
                domain,
                POLICY_VERSION,
                risk_version,
            )
            row = await conn.fetchrow(
                "SELECT *,clock_timestamp() AS db_now FROM email_auth_domain_decisions "
                "WHERE domain=$1 FOR UPDATE",
                domain,
            )
            db_now = await conn.fetchval("SELECT clock_timestamp()")
            if row["status"] == "revoked":
                return dict(row), None
            if row["expires_at"] > db_now and (row["policy_version"], row["risk_version"]) == (
                POLICY_VERSION,
                risk_version,
            ):
                return dict(row), None
            if row["lease_until"] and row["lease_until"] > db_now:
                return None, None
            await conn.execute(
                """UPDATE email_auth_domain_decisions SET review_id=$2,
                   lease_until=clock_timestamp()+INTERVAL '10 seconds'
                   WHERE domain=$1""",
                domain,
                review_id,
            )
            return None, int(row["generation"])

    async def publish_review(self, decision: DomainDecision, review_id: str, generation: int):
        async with self.pool.acquire() as conn, conn.transaction():
            await self._active_policy(conn, decision.risk_version)
            row = await conn.fetchrow(
                """UPDATE email_auth_domain_decisions SET status=$2,reason=$3,
                   policy_version=$4,risk_version=$5,checked_at=clock_timestamp(),
                   expires_at=$6,review_id=NULL,lease_until=NULL,certificate_status=$9
                   WHERE domain=$1 AND generation=$7 AND review_id=$8 AND status<>'revoked'
                   RETURNING *""",
                decision.domain,
                decision.status,
                decision.reason,
                decision.policy_version,
                decision.risk_version,
                datetime.fromtimestamp(decision.expires_at, UTC),
                generation,
                review_id,
                decision.certificate_status,
            )
            return dict(row) if row else None

    @staticmethod
    async def _admit(conn, domain: str, risk_version: str):
        await PostgresEmailAuthStore._active_policy(conn, risk_version)
        row = await conn.fetchrow(
            """SELECT *,clock_timestamp() AS db_now FROM email_auth_domain_decisions
               WHERE domain=$1 FOR SHARE""",
            domain,
        )
        now = await conn.fetchval("SELECT clock_timestamp()")
        if (
            not row
            or row["status"] != "approved"
            or row["expires_at"] <= now
            or (row["policy_version"], row["risk_version"]) != (POLICY_VERSION, risk_version)
        ):
            raise EmailAuthError("domain_not_approved", "Email domain approval is required.", 403)
        return row

    @staticmethod
    async def _fresh_after_wait(conn, decision) -> None:
        if decision["expires_at"] <= await conn.fetchval("SELECT clock_timestamp()"):
            raise EmailAuthError(
                "domain_review_pending", "Refresh domain approval and try again.", 202
            )

    async def verification_budget(self, client_hash: str) -> None:
        allowed = True
        async with self.pool.acquire() as conn, conn.transaction():
            for key, limit in [
                ("verify:client:" + client_hash, 60),
                ("verify:global", 600),
            ]:
                if not await self._budget(conn, key, limit, 60):
                    allowed = False
                    break
        if not allowed:
            raise EmailAuthError("rate_limited", "Wait before trying again.", 429)

    async def create_challenge(self, row: dict, risk_version: str) -> dict:
        error = None
        answer = None
        async with self.pool.acquire() as conn, conn.transaction():
            decision = await self._admit(conn, row["domain"], risk_version)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended($1,359))", row["destination_hash"]
            )
            await self._fresh_after_wait(conn, decision)
            existing = await conn.fetchrow(
                """SELECT * FROM email_auth_challenges WHERE destination_hash=$1
                   AND browser_hash=$2 AND request_key=$3 AND expires_at>clock_timestamp()
                   AND cancelled_at IS NULL AND consumed_at IS NULL""",
                row["destination_hash"],
                row["browser_hash"],
                row["request_key"],
            )
            if existing:
                return dict(existing)
            recent = await conn.fetchval(
                """SELECT 1 FROM email_auth_challenges WHERE destination_hash=$1
                   AND created_at>clock_timestamp()-INTERVAL '60 seconds' LIMIT 1""",
                row["destination_hash"],
            )
            allowed = not recent
            for key, limit, seconds in [
                ("send:15m:" + row["destination_hash"], 3, 900),
                ("send:hour:" + row["destination_hash"], 10, 3600),
                ("send:domain:" + row["domain"], 60, 60),
                ("send:global", 600, 60),
            ]:
                if not allowed:
                    break
                allowed = await self._budget(conn, key, limit, seconds)
            if not allowed:
                error = EmailAuthError("rate_limited", "Wait before requesting another code.", 429)
            else:
                await self._fresh_after_wait(conn, decision)
                db_now = await conn.fetchval("SELECT clock_timestamp()")
                if not 0 < (row["expires_at"] - db_now).total_seconds() <= 300:
                    raise EmailAuthError("clock_unavailable", "Restart email sign-in.", 503)
                await conn.execute(
                    """UPDATE email_auth_challenges SET cancelled_at=clock_timestamp(),
                       payload=NULL,delivery_state='cancelled' WHERE destination_hash=$1
                       AND consumed_at IS NULL AND cancelled_at IS NULL""",
                    row["destination_hash"],
                )
                answer = await conn.fetchrow(
                    """INSERT INTO email_auth_challenges
                       (challenge_id,destination_hash,domain,decision_generation,browser_hash,
                       request_key,verifier,verifier_version,payload,payload_version,expected_uid,
                        destination_ciphertext,
                        expires_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,'v1',$8,'v1',$9,$10,
                               $11) RETURNING *""",
                    row["challenge_id"],
                    row["destination_hash"],
                    row["domain"],
                    decision["generation"],
                    row["browser_hash"],
                    row["request_key"],
                    row["verifier"],
                    row["payload"],
                    row.get("expected_uid"),
                    row["destination_ciphertext"],
                    row["expires_at"],
                )
        if error:
            raise error
        return dict(answer)

    async def challenge(self, challenge_id: str) -> dict | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM email_auth_challenges WHERE challenge_id=$1", challenge_id
            )
            return dict(row) if row else None

    async def consume(
        self, challenge_id: str, browser_hash: str, verifier: str, risk_version: str
    ) -> dict:
        preliminary = await self.challenge(challenge_id)
        if not preliminary:
            raise EmailAuthError("invalid_code", "The code is invalid or expired.")
        result = None
        async with self.pool.acquire() as conn, conn.transaction():
            domain = await self._admit(conn, preliminary["domain"], risk_version)
            row = await conn.fetchrow(
                "SELECT *,clock_timestamp() AS db_now FROM email_auth_challenges "
                "WHERE challenge_id=$1 FOR UPDATE",
                challenge_id,
            )
            await self._fresh_after_wait(conn, domain)
            now = await conn.fetchval("SELECT clock_timestamp()")
            eligible = bool(
                row
                and row["consumed_at"] is None
                and row["cancelled_at"] is None
                and row["expires_at"] > now
                and row["attempts"] < MAX_ATTEMPTS
                and row["decision_generation"] == domain["generation"]
                and hmac.compare_digest(row["browser_hash"], browser_hash)
            )
            if eligible:
                allowed = await self._budget(conn, "guess:" + row["destination_hash"], 10, 3600)
                await self._fresh_after_wait(conn, domain)
                if row["expires_at"] <= await conn.fetchval("SELECT clock_timestamp()"):
                    raise EmailAuthError("invalid_code", "The code is invalid or expired.")
                correct = allowed and hmac.compare_digest(row["verifier"], verifier)
                await conn.execute(
                    """UPDATE email_auth_challenges SET attempts=attempts+1,
                       consumed_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
                       payload=CASE WHEN $2 OR attempts+1>=5 THEN NULL ELSE payload END,
                       delivery_state=CASE WHEN $2 OR attempts+1>=5 THEN 'cancelled'
                                           ELSE delivery_state END
                       WHERE challenge_id=$1""",
                    challenge_id,
                    correct,
                )
                if correct:
                    result = dict(row)
        # Raise after commit: invalid guesses must not roll back their counters.
        if not result:
            raise EmailAuthError("invalid_code", "The code is invalid or expired.")
        return result

    async def enrollment(self, destination_hash: str) -> str | None:
        async with self.pool.acquire() as conn:
            return await conn.fetchval(
                "SELECT user_id FROM email_auth_enrollments WHERE destination_hash=$1",
                destination_hash,
            )

    async def reserve_new_identity(self, destination_hash: str, user_id: str) -> str:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """INSERT INTO email_auth_enrollments(destination_hash,user_id,status)
                   VALUES($1,$2,'provisional')
                   ON CONFLICT(destination_hash) DO UPDATE
                   SET destination_hash=EXCLUDED.destination_hash RETURNING user_id""",
                destination_hash,
                user_id,
            )
            await conn.execute(
                "UPDATE email_auth_challenges SET expected_uid=$2 "
                "WHERE destination_hash=$1 AND expected_uid IS NULL",
                destination_hash,
                row["user_id"],
            )
            return row["user_id"]

    async def activate_enrollment(self, destination_hash: str, user_id: str) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                "UPDATE email_auth_enrollments SET status='active' WHERE destination_hash=$1 "
                "AND user_id=$2",
                destination_hash,
                user_id,
            )

    async def finalize_login(
        self,
        challenge_id: str,
        browser_hash: str,
        user_id: str,
        risk_version: str,
        mint: Callable[[], Awaitable[str]],
    ) -> str:
        from hushh_mcp.services.account_deletion_lifecycle_service import (
            _ACCOUNT_LIFECYCLE_LOCK_NAMESPACE,
            _CONNECTION_GRAPH_LOCK_NAMESPACE,
            account_deletion_user_hash,
        )

        initial = await self.challenge(challenge_id)
        if not initial:
            raise EmailAuthError("enrollment_expired", "Restart email sign-in.")
        async with self.pool.acquire() as conn, conn.transaction(isolation="read_committed"):
            await conn.execute("SET LOCAL lock_timeout='3s'")
            # One finalization per UID. Mint before holding any challenge rows:
            # Firebase's deletion check uses a separate connection's 171->198
            # barriers, while deletion holds those barriers before row cleanup.
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,3591))", user_id)
            token = await mint()
            for namespace in (_CONNECTION_GRAPH_LOCK_NAMESPACE, _ACCOUNT_LIFECYCLE_LOCK_NAMESPACE):
                await conn.execute(
                    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,$2))",
                    user_id,
                    namespace,
                )
            if await conn.fetchval(
                "SELECT 1 FROM account_deletion_tombstones WHERE user_id_hash=$1",
                account_deletion_user_hash(user_id),
            ):
                raise EmailAuthError("account_unavailable", "This account is unavailable.", 403)
            decision = await self._admit(conn, initial["domain"], risk_version)
            row = await conn.fetchrow(
                "SELECT * FROM email_auth_challenges WHERE challenge_id=$1 FOR UPDATE", challenge_id
            )
            now = await conn.fetchval("SELECT clock_timestamp()")
            await self._fresh_after_wait(conn, decision)
            if not (
                row
                and row["consumed_at"]
                and row["decision_generation"] == decision["generation"]
                and not row["cancelled_at"]
                and row["expires_at"] > now
                and not row["enrollment_finalized_at"]
                and hmac.compare_digest(row["browser_hash"], browser_hash)
            ):
                raise EmailAuthError("enrollment_expired", "Restart email sign-in.")
            bindings = await conn.fetch(
                """SELECT * FROM email_auth_enrollments WHERE destination_hash=$1 OR user_id=$2
                   ORDER BY destination_hash FOR UPDATE""",
                row["destination_hash"],
                user_id,
            )
            for binding in bindings:
                if binding["user_id"] == user_id:
                    continue
                if binding["status"] != "provisional":
                    raise EmailAuthError(
                        "account_conflict", "Use your existing sign-in method.", 409
                    )
                # UID references are immutable under migration 201. Replace
                # only an unused reservation; never re-parent its identity.
                await conn.execute(
                    "DELETE FROM email_auth_enrollments WHERE destination_hash=$1",
                    binding["destination_hash"],
                )
            if any(binding["user_id"] == user_id for binding in bindings):
                await conn.execute(
                    "UPDATE email_auth_enrollments SET destination_hash=$1,status='active' WHERE user_id=$2",
                    row["destination_hash"],
                    user_id,
                )
            else:
                await conn.execute(
                    "INSERT INTO email_auth_enrollments(destination_hash,user_id) VALUES($1,$2)",
                    row["destination_hash"],
                    user_id,
                )
            await self._fresh_after_wait(conn, decision)
            if row["expires_at"] <= await conn.fetchval("SELECT clock_timestamp()"):
                raise EmailAuthError("enrollment_expired", "Restart email sign-in.")
            await conn.execute(
                """UPDATE email_auth_challenges SET enrollment_finalized_at=clock_timestamp(),
                   expected_uid=$2,enrollment_ticket_hash=NULL,destination_ciphertext=NULL WHERE challenge_id=$1""",
                challenge_id,
                user_id,
            )
        return token

    async def revoke_domain(
        self, domain: str, *, actor: str = "system", reason: str = "emergency_revocation"
    ) -> None:
        audit_reason = json.dumps(
            {"decision": "operator_revoked", "actor": actor[:128], "reason": reason[:256]},
            separators=(",", ":"),
        )
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute(
                """INSERT INTO email_auth_domain_decisions
                   (domain,status,reason,policy_version,risk_version,expires_at,generation)
                   VALUES($1,'revoked',$3,$2,'revoked',clock_timestamp(),1)
                   ON CONFLICT(domain) DO UPDATE SET status='revoked',
                   reason=$3,generation=email_auth_domain_decisions.generation+1,
                   review_id=NULL,lease_until=NULL""",
                domain,
                POLICY_VERSION,
                audit_reason,
            )
            await conn.execute(
                """UPDATE email_auth_challenges SET cancelled_at=clock_timestamp(),
                   payload=NULL,delivery_state='cancelled'
                   WHERE domain=$1 AND consumed_at IS NULL""",
                domain,
            )

    async def cleanup(self) -> None:
        async with self.pool.acquire() as conn, conn.transaction():
            if not await conn.fetchval("SELECT to_regclass('email_auth_challenges')"):
                return
            await conn.execute(
                """UPDATE email_auth_challenges SET payload=NULL,destination_ciphertext=NULL,
                   enrollment_ticket_hash=NULL,delivery_state='cancelled'
                   WHERE expires_at<=clock_timestamp()"""
            )
            await conn.execute(
                "DELETE FROM email_auth_challenges WHERE expires_at<clock_timestamp()-INTERVAL '1 day'"
            )
            await conn.execute("DELETE FROM email_auth_budgets WHERE expires_at<clock_timestamp()")

    async def delivery_candidate(self) -> dict | None:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT * FROM email_auth_challenges WHERE payload IS NOT NULL
                   AND consumed_at IS NULL AND cancelled_at IS NULL
                   AND expires_at>clock_timestamp()+INTERVAL '15 seconds'
                   AND next_attempt_at<=clock_timestamp()
                   AND (delivery_state='queued' OR
                        (delivery_state='leased' AND lease_until<=clock_timestamp()))
                   ORDER BY next_attempt_at LIMIT 1"""
            )
            return dict(row) if row else None

    async def lease_delivery(self, candidate: dict, lease_id: str, risk_version: str):
        async with self.pool.acquire() as conn, conn.transaction():
            decision = await self._admit(conn, candidate["domain"], risk_version)
            row = await conn.fetchrow(
                """UPDATE email_auth_challenges SET delivery_state='leased',
                   delivery_lease_id=$2,lease_until=clock_timestamp()+INTERVAL '20 seconds'
                   WHERE challenge_id=$1 AND payload IS NOT NULL
                   AND consumed_at IS NULL AND cancelled_at IS NULL
                   AND decision_generation=$3
                   AND expires_at>clock_timestamp()+INTERVAL '15 seconds'
                   AND next_attempt_at<=clock_timestamp()
                   AND (delivery_state='queued' OR
                        (delivery_state='leased' AND lease_until<=clock_timestamp()))
                   RETURNING *""",
                candidate["challenge_id"],
                lease_id,
                decision["generation"],
            )
            if row:
                await self._fresh_after_wait(conn, decision)
            return dict(row) if row else None

    async def finish_delivery(self, challenge_id: str, lease_id: str, accepted: bool) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                """UPDATE email_auth_challenges
                   SET delivery_state=CASE WHEN $3 THEN 'accepted' ELSE 'queued' END,
                       payload=CASE WHEN $3 THEN NULL ELSE payload END,
                       next_attempt_at=clock_timestamp()+INTERVAL '30 seconds',
                       delivery_lease_id=NULL,lease_until=NULL
                   WHERE challenge_id=$1 AND delivery_lease_id=$2
                   AND cancelled_at IS NULL AND consumed_at IS NULL""",
                challenge_id,
                lease_id,
                accepted,
            )

    @asynccontextmanager
    async def delivery_authority(self, challenge_id: str, lease_id: str, risk_version: str):
        """Serialize revocation/consumption with the bounded external submission."""
        initial = await self.challenge(challenge_id)
        if not initial:
            raise EmailAuthError("delivery_cancelled", "Delivery is unavailable.", 403)
        async with self.pool.acquire() as conn, conn.transaction():
            decision = await self._admit(conn, initial["domain"], risk_version)
            row = await conn.fetchrow(
                "SELECT * FROM email_auth_challenges WHERE challenge_id=$1 FOR UPDATE", challenge_id
            )
            now = await conn.fetchval("SELECT clock_timestamp()")
            await self._fresh_after_wait(conn, decision)
            if not (
                row
                and row["payload"]
                and not row["cancelled_at"]
                and not row["consumed_at"]
                and row["delivery_state"] == "leased"
                and row["delivery_lease_id"] == lease_id
                and row["lease_until"] > now
                and row["expires_at"].timestamp() - now.timestamp() >= 15
                and row["decision_generation"] == decision["generation"]
            ):
                raise EmailAuthError("delivery_cancelled", "Delivery is unavailable.", 403)
            yield dict(row)
            await conn.execute(
                "UPDATE email_auth_challenges SET delivery_state='accepted',payload=NULL,"
                "delivery_lease_id=NULL,lease_until=NULL WHERE challenge_id=$1",
                challenge_id,
            )

    async def defer_delivery(self, challenge_id: str) -> None:
        async with self.pool.acquire() as conn:
            await conn.execute(
                "UPDATE email_auth_challenges SET next_attempt_at=clock_timestamp()+"
                "INTERVAL '15 seconds' WHERE challenge_id=$1",
                challenge_id,
            )
