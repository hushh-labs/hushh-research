"""Independent email challenge orchestration with replaceable narrow adapters."""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import time
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from hushh_mcp.services.email_auth.config import EmailAuthConfig
from hushh_mcp.services.email_auth.contracts import (
    EmailAuthError,
    PayloadCipher,
    generate_code,
    keyed_digest,
    normalize_email,
    validate_binding,
)


class EmailAuthService:
    def __init__(self, config: EmailAuthConfig, store, evaluator, identity):
        self.config = config
        self.store = store
        self.evaluator = evaluator
        self.identity = identity
        self.cipher = PayloadCipher(config.payload_key)

    async def approve_domain(self, domain: str) -> dict:
        if self.evaluator.risk.expires_at <= time.time():
            raise EmailAuthError(
                "domain_review_pending", "Domain checks are temporarily unavailable.", 503
            )
        review_id = secrets.token_urlsafe(24)
        row, generation = await self.store.claim_review(
            domain, self.evaluator.risk.version, review_id
        )
        if generation is not None:
            decision = await self.evaluator.evaluate(domain)
            if decision.status == "approved":
                decision = replace(
                    decision, certificate_status=await self.evaluator.certificate_evidence(domain)
                )
            row = await self.store.publish_review(decision, review_id, generation)
        if not row or row["status"] == "pending":
            raise EmailAuthError(
                "domain_review_pending", "Checking this email domain. Try again shortly.", 202
            )
        if row["status"] != "approved":
            raise EmailAuthError(
                "email_domain_not_approved", "Email sign-in is unavailable for this domain.", 403
            )
        return row

    def _digest(self, *values: str) -> str:
        return keyed_digest(self.config.verifier_key, *values)

    async def request(
        self, email: str, browser_binding: str, request_key: str, client: str
    ) -> dict:
        self.config.require_ready()
        validate_binding(browser_binding)
        email, domain = normalize_email(email)
        await self.store.discovery_budget(self._digest("client", client), domain)
        await self.approve_domain(domain)
        challenge_id = secrets.token_urlsafe(32)
        code = generate_code()
        destination_hash = keyed_digest(self.config.lookup_key, "destination", email)
        capture = {}
        if os.getenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "").strip().lower() == "true":
            from api.utils.firebase_auth import current_auth_lane

            existing = await asyncio.to_thread(self.identity.find, email)
            identity_uid = (
                existing.uid
                if existing
                else await self.store.reserve_new_identity(
                    destination_hash, "email_" + secrets.token_urlsafe(24)
                )
            )
            capture = await self.store.capture_identity(identity_uid, current_auth_lane())
            capture["identity_reserved"] = existing is None
        expiry = datetime.now(UTC) + timedelta(minutes=5)
        associated = f"otp:{challenge_id}:{destination_hash}:{expiry.isoformat()}"
        row = await self.store.create_challenge(
            {
                "challenge_id": challenge_id,
                "destination_hash": destination_hash,
                "domain": domain,
                "browser_hash": self._digest("browser", browser_binding),
                "request_key": request_key,
                "verifier": self._digest(
                    "code", challenge_id, destination_hash, expiry.isoformat(), code
                ),
                "payload": self.cipher.seal(json.dumps({"email": email, "code": code}), associated),
                "destination_ciphertext": self.cipher.seal(email, f"destination:{challenge_id}"),
                "expires_at": expiry,
                **capture,
            },
            self.evaluator.risk.version,
        )
        return {
            "status": "accepted",
            "challenge_id": row["challenge_id"],
            "expires_at": row["expires_at"].isoformat(),
            "resend_at": row["created_at"].timestamp() + 60,
            "destination": email[0] + "***@" + domain,
        }

    async def verify(
        self, challenge_id: str, code: str, browser_binding: str, client: str = "unknown"
    ) -> dict:
        self.config.require_ready()
        await self.store.verification_budget(self._digest("client", client))
        validate_binding(browser_binding)
        if not re.fullmatch(r"[0-9]{6}", code):
            raise EmailAuthError("invalid_code", "Enter the six-digit code.")
        row = await self.store.challenge(challenge_id)
        if not row:
            raise EmailAuthError("invalid_code", "The code is invalid or expired.")
        await self.approve_domain(row["domain"])
        consumed = await self.store.consume(
            challenge_id,
            self._digest("browser", browser_binding),
            self._digest(
                "code", challenge_id, row["destination_hash"], row["expires_at"].isoformat(), code
            ),
            self.evaluator.risk.version,
        )
        email = self.cipher.open(consumed["destination_ciphertext"], f"destination:{challenge_id}")
        if consumed.get("identity_lane"):
            from api.utils.firebase_auth import current_auth_lane

            if consumed["identity_lane"] != current_auth_lane():
                raise EmailAuthError("account_unavailable", "Restart email sign-in.", 409)
            # Exact UID was captured before delivery. Never find by email now.
            if consumed["purpose"] == "account_enrollment":
                await asyncio.to_thread(
                    self.identity.verify_mailbox, consumed["expected_uid"], email
                )
                ticket = secrets.token_urlsafe(32)
                status = await self.store.prepare_registration(
                    challenge_id,
                    self._digest("browser", browser_binding),
                    self._digest("enrollment", challenge_id, ticket),
                    self.evaluator.risk.version,
                    current_auth_lane(),
                )
                return {
                    "status": "registration_required",
                    "registration": status,
                    **({"enrollment_ticket": ticket} if status["state"] == "ready" else {}),
                }
            owner_uid = consumed["user_id"]
            if consumed["identity_reserved"] is True:
                if owner_uid != consumed["expected_uid"] or consumed["account_generation"] != 0:
                    raise EmailAuthError("account_conflict", "Restart email sign-in.", 409)
                await asyncio.to_thread(self.identity.provision, owner_uid, email)
            else:
                await asyncio.to_thread(
                    self.identity.verify_mailbox, consumed["expected_uid"], email
                )
        else:
            # Pre-generation compatibility is generation-zero only. Drain these
            # old consumers/challenges before enabling replacement enrollment.
            if os.getenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "").strip().lower() == "true":
                raise EmailAuthError("enrollment_expired", "Restart email sign-in.", 409)
            existing = await asyncio.to_thread(self.identity.find, email)
            if existing is not None:
                owner_uid = existing.uid
            else:
                owner_uid = await self.store.reserve_new_identity(
                    row["destination_hash"], "email_" + secrets.token_urlsafe(24)
                )
                await asyncio.to_thread(self.identity.provision, owner_uid, email)

        # Firebase rechecks the current primary email, verification, disabled,
        # offboarding and deletion state before issuing a token. Keep the token
        # private until the same consumed proof and live domain policy finalize.
        async def mint() -> str:
            return await asyncio.wait_for(
                asyncio.to_thread(self.identity.issue, owner_uid, email),
                timeout=10,
            )

        token = await self.store.finalize_login(
            challenge_id,
            self._digest("browser", browser_binding),
            owner_uid,
            self.evaluator.risk.version,
            mint,
        )
        return {"status": "authenticated", "custom_token": token}

    async def complete_registration(
        self,
        challenge_id: str,
        browser_binding: str,
        ticket: str,
        accepted_digest: str,
        client: str,
    ) -> dict:
        self.config.require_ready()
        if os.getenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "").strip().lower() != "true":
            raise EmailAuthError(
                "enrollment_unavailable", "Account recovery is not available.", 404
            )
        validate_binding(browser_binding)
        await self.store.verification_budget(self._digest("client", client))
        row = await self.store.challenge(challenge_id)
        if not row or not row.get("destination_ciphertext") or not row.get("expected_uid"):
            raise EmailAuthError("enrollment_expired", "Request a new sign-in code.", 409)
        email = self.cipher.open(row["destination_ciphertext"], f"destination:{challenge_id}")
        await asyncio.to_thread(self.identity.verify_mailbox, row["expected_uid"], email)
        from api.utils.firebase_auth import current_auth_lane

        principal = await self.store.confirm_registration(
            challenge_id,
            self._digest("browser", browser_binding),
            self._digest("enrollment", challenge_id, ticket),
            accepted_digest,
            self.evaluator.risk.version,
            current_auth_lane(),
        )
        # Proof is now consumed and activation committed. A failed/lost mint is
        # recovered by a new normal email code, not by replaying enrollment.
        token = await asyncio.wait_for(
            asyncio.to_thread(self.identity.issue, principal["owner_id"], email), timeout=10
        )
        await self.store.release_registration_token(
            challenge_id,
            principal["owner_id"],
            self._digest("browser", browser_binding),
            self.evaluator.risk.version,
            current_auth_lane(),
        )
        return {"status": "authenticated", "custom_token": token}
