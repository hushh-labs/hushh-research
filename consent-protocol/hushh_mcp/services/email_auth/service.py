"""Independent email challenge orchestration with replaceable narrow adapters."""

from __future__ import annotations

import asyncio
import json
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
        existing = await asyncio.to_thread(self.identity.find, email)
        if existing is not None:
            # Mailbox proof authenticates the existing canonical identity. It
            # never creates a second account or merges two Firebase identities.
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
