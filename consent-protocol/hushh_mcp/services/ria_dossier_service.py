"""Post-claim background dossier: scan the claimed SEC identity, mail the result.

A successful claim dispatches a fire-and-forget worker that resolves the
claimant's sign-in email, sends a redacted SEC-sourced payload to the HushhOne
intelligence scan API (the claim is the identity pivot, passed as a
``confirmedProfiles`` anchor), polls until the dossier markdown is ready, and
hands the result to the dossier mail lane.

Doctrine: the dossier is best-effort end to end — a claim must never fail, and
every worker fault lands in the ``ria_claim_dossiers`` row status, never in the
claim response. Idempotency is the ``(ria_profile_id, crd_number)`` unique key:
``INSERT ... ON CONFLICT DO NOTHING RETURNING id`` picks exactly one winner, so
re-claims and email upgrades are harmless no-ops.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import asyncpg
import httpx

from db.connection import get_pool
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.ria_claim_service import (
    firm_website_host,
    mask_email,
    title_case_name,
)

logger = logging.getLogger(__name__)

# Documented poll cadence for /api/v1/scan/{id}; the pipeline's own soft
# deadline is 27.5 min, so 35 min is a hard cap, not a tuning knob.
_SCAN_POLL_INTERVAL_SECONDS = 10.0
_SCAN_POLL_CAP_SECONDS = 35 * 60.0

# Strong references keep fire-and-forget workers alive until they finish
# (asyncio holds tasks weakly); mirrors the Gmail sync tracked-task pattern.
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()


def _track_background_task(task: asyncio.Task[Any]) -> None:
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _ensure_url_scheme(value: str) -> str:
    if not value:
        return ""
    return value if "://" in value else f"https://{value}"


class RIADossierService:
    """Orchestrates the claim → scan → mail pipeline; never blocks a claim."""

    def __init__(
        self,
        *,
        identity_service: ActorIdentityService | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._identity_service = identity_service or ActorIdentityService()
        self._transport = transport
        self._poll_interval_seconds = _SCAN_POLL_INTERVAL_SECONDS
        self._poll_cap_seconds = _SCAN_POLL_CAP_SECONDS

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------

    async def dispatch_after_claim(
        self,
        *,
        user_id: str,
        ria_profile_id: str,
        claim_type: str,
        reference_metadata: dict[str, Any],
    ) -> dict[str, Any]:
        """Atomically claim the dossier row; only the winner spawns the worker.

        Returns ``{"status": "queued", "email_masked"?}`` for the winner and
        ``{"status": "skipped", "reason"}`` for everyone else (re-claims,
        upgrades, unverified claims, and environments where the table has not
        been migrated yet).
        """
        metadata = reference_metadata if isinstance(reference_metadata, dict) else {}
        if _clean_text(metadata.get("verification_level")) != "verified":
            return {"status": "skipped", "reason": "not_verified"}
        profile_id = _clean_text(ria_profile_id)
        crd_number = self._crd_for_claim(claim_type, metadata)
        if not profile_id or not crd_number:
            return {"status": "skipped", "reason": "missing_claim_target"}

        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    INSERT INTO ria_claim_dossiers (ria_profile_id, crd_number, user_id, status)
                    VALUES ($1, $2, $3, 'queued')
                    ON CONFLICT (ria_profile_id, crd_number) DO NOTHING
                    RETURNING id
                    """,
                    profile_id,
                    crd_number,
                    _clean_text(user_id),
                )
        except asyncpg.UndefinedTableError:
            # Deploys may precede the migration in dev; the dossier is
            # best-effort, so a missing table is a skip, never a fault.
            logger.warning("ria.dossier_table_missing")
            return {"status": "skipped", "reason": "table_missing"}
        if row is None:
            return {"status": "skipped", "reason": "already_dispatched"}

        task = asyncio.create_task(
            self._run_worker(
                dossier_id=int(row["id"]),
                user_id=_clean_text(user_id),
                ria_profile_id=profile_id,
                claim_type=claim_type,
                reference_metadata=metadata,
            )
        )
        _track_background_task(task)
        logger.info("ria.dossier_dispatched claim_type=%s", claim_type)

        result: dict[str, Any] = {"status": "queued"}
        email = await self._cached_email(_clean_text(user_id))
        if email:
            result["email_masked"] = mask_email(email)
        return result

    @staticmethod
    def _crd_for_claim(claim_type: str, metadata: dict[str, Any]) -> str:
        key = "individual_crd" if claim_type == "individual" else "firm_crd"
        value = metadata.get(key)
        if value in (None, ""):
            return ""
        return str(value)

    async def _cached_email(self, user_id: str) -> str:
        """Cheap cache read so the done screen can show the masked address."""
        try:
            identity = (await self._identity_service.get_many([user_id])).get(user_id) or {}
        except Exception:  # noqa: BLE001 - the masked line is cosmetic
            return ""
        return _clean_text(identity.get("email")).lower()

    # ------------------------------------------------------------------
    # Worker
    # ------------------------------------------------------------------

    async def _run_worker(
        self,
        *,
        dossier_id: int,
        user_id: str,
        ria_profile_id: str,
        claim_type: str,
        reference_metadata: dict[str, Any],
        resume_scan_id: str = "",
    ) -> None:
        try:
            email = await self._resolve_email(user_id)
            if not email:
                # Visible on the profile row, not silent.
                logger.warning("ria.dossier_blocked reason=no_email")
                await self._update_row(dossier_id, completed=True, status="blocked_no_email")
                return

            scan_id = _clean_text(resume_scan_id)
            if not scan_id:
                display_name = await self._profile_display_name(ria_profile_id, reference_metadata)
                zip_code, zip_source = await self._resolve_scan_zip(reference_metadata)
                payload, payload_error = self._build_scan_payload(
                    claim_type=claim_type,
                    reference_metadata=reference_metadata,
                    email=email,
                    display_name=display_name,
                    zip_code=zip_code,
                )
                if payload is None:
                    # Every abandoned dossier used to end here with no log line
                    # at all, which is why a dead lane looked like a quiet one.
                    logger.warning("ria.dossier_blocked reason=%s", payload_error)
                    await self._update_row(
                        dossier_id, completed=True, status="scan_failed", error=payload_error
                    )
                    return
                logger.info("ria.dossier_scan_starting zip_source=%s", zip_source)

                scan_id, scan_error = await self._start_scan(payload)
                if not scan_id:
                    logger.warning("ria.dossier_blocked reason=%s", scan_error)
                    await self._update_row(
                        dossier_id, completed=True, status="scan_failed", error=scan_error
                    )
                    return
                await self._update_row(dossier_id, status="scanning", scan_id=scan_id)
            else:
                display_name = await self._profile_display_name(ria_profile_id, reference_metadata)

            scan_result = await self._poll_scan(scan_id)
            if scan_result is None:
                logger.warning("ria.dossier_blocked reason=scan_did_not_complete")
                await self._update_row(
                    dossier_id, completed=True, status="scan_failed", error="scan_did_not_complete"
                )
                return
            markdown, summary = scan_result
            if not await self._claim_generated(dossier_id, markdown=markdown, summary=summary):
                # A concurrent worker (a resume racing the original) already
                # took this row past `scanning`; exactly one of us may mail.
                logger.info("ria.dossier_generate_lost_race")
                return

            await self._queue_mail(
                dossier_id=dossier_id,
                user_id=user_id,
                to_email=email,
                display_name=display_name,
            )
        except Exception:  # noqa: BLE001 - worker faults land in the row, nowhere else
            logger.warning("ria.dossier_worker_failed", exc_info=True)
            try:
                await self._update_row(
                    dossier_id, completed=True, status="scan_failed", error="worker_error"
                )
            except Exception:  # noqa: BLE001 - even the row write is best-effort
                logger.warning("ria.dossier_row_update_failed", exc_info=True)

    async def _resolve_email(self, user_id: str) -> str:
        """Sign-in email from the identity cache, then live Firebase."""
        identity: dict[str, Any] = {}
        try:
            identity = (await self._identity_service.ensure_many([user_id])).get(user_id) or {}
        except Exception:  # noqa: BLE001 - fall through to the live Firebase read
            logger.info("ria.dossier_identity_cache_failed", exc_info=True)
        email = _clean_text(identity.get("email")).lower()
        if email:
            return email
        try:
            refreshed = await self._identity_service.sync_from_firebase(user_id, force=True) or {}
        except Exception:  # noqa: BLE001 - no email is a row status, not a crash
            return ""
        return _clean_text(refreshed.get("email")).lower()

    async def _profile_display_name(
        self, ria_profile_id: str, reference_metadata: dict[str, Any]
    ) -> str:
        try:
            pool = await get_pool()
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT display_name FROM ria_profiles WHERE id = $1",
                    ria_profile_id,
                )
            if row is not None and row["display_name"]:
                return str(row["display_name"])
        except Exception:  # noqa: BLE001 - fall back to the claim snapshot
            logger.info("ria.dossier_profile_name_lookup_failed", exc_info=True)
        firm_record_raw = reference_metadata.get("firm_record")
        firm_record = firm_record_raw if isinstance(firm_record_raw, dict) else {}
        return title_case_name(_clean_text(firm_record.get("name")))

    # ------------------------------------------------------------------
    # Scan payload (redaction boundary)
    # ------------------------------------------------------------------

    async def _resolve_scan_zip(self, reference_metadata: dict[str, Any]) -> tuple[str, str]:
        """The scan's required coarse location, as ``(zip, source)``.

        The scan API takes ``zipCode`` OR lat/lng and rejects the body without
        one, so a missing zip is not a degraded dossier — it is no dossier at
        all. IAPD publishes plenty of records with a city and state but a null
        zip (street/zip simply absent), which stranded every such adviser at
        ``no_location``; the place lookups below recover the zip from the city
        and state that ARE published.

        Privacy is unchanged from the payload contract: a branch flagged
        ``private_residence`` is never a location source, at any precision —
        the firm's own public address stands in. A city-level lookup is used
        rather than lat/lng on purpose, so the scan records this as the coarse
        location it actually is instead of a precise one.
        """
        firm_raw = reference_metadata.get("firm_record")
        firm = firm_raw if isinstance(firm_raw, dict) else {}
        advisor_raw = reference_metadata.get("advisor_record")
        advisor = advisor_raw if isinstance(advisor_raw, dict) else {}
        branch_raw = advisor.get("branch")
        branch = branch_raw if isinstance(branch_raw, dict) else {}
        branch_is_public = bool(branch) and not branch.get("private_residence")

        if branch_is_public and _clean_text(branch.get("zip")):
            return _clean_text(branch.get("zip")), "branch"
        if _clean_text(firm.get("zip")):
            return _clean_text(firm.get("zip")), "firm"

        # Nothing published. Recover it from the public city/state, firm
        # listing first (an exact business address) then the city itself.
        candidates: list[tuple[str, str]] = []
        firm_name = _clean_text(firm.get("name"))
        firm_place = ", ".join(
            part
            for part in (firm_name, _clean_text(firm.get("city")), _clean_text(firm.get("state")))
            if part
        )
        if firm_name and _clean_text(firm.get("city")):
            candidates.append((firm_place, "firm_place"))
        firm_city = ", ".join(
            part for part in (_clean_text(firm.get("city")), _clean_text(firm.get("state"))) if part
        )
        if _clean_text(firm.get("city")):
            candidates.append((f"{firm_city}, USA", "firm_city"))
        if branch_is_public and _clean_text(branch.get("city")):
            branch_city = ", ".join(
                part
                for part in (_clean_text(branch.get("city")), _clean_text(branch.get("state")))
                if part
            )
            candidates.append((f"{branch_city}, USA", "branch_city"))

        for query, source in candidates:
            try:
                resolved = await self._maps_postal_code(query)
            except Exception:  # noqa: BLE001 - enrichment never breaks the worker
                logger.info("ria.dossier_zip_lookup_failed", exc_info=True)
                continue
            if resolved:
                return resolved, source
        return "", ""

    async def _maps_postal_code(self, query: str) -> str:
        """Seam for the place lookup so tests never reach the network."""
        from hushh_mcp.services.google_maps_service import GoogleMapsService

        return await GoogleMapsService().resolve_postal_code(query=query)

    @staticmethod
    def _build_scan_payload(
        *,
        claim_type: str,
        reference_metadata: dict[str, Any],
        email: str,
        display_name: str,
        zip_code: str,
    ) -> tuple[dict[str, Any] | None, str]:
        """Build the redacted scan body from the claim snapshot.

        Only SEC/IAPD-published facts plus the resolved sign-in email ever
        cross this boundary. NEVER forwarded: the possession phone digits, the
        evidence ledger / satisfied / missing / scope note, the claim ticket,
        any street address — and the branch zip whenever the branch is a
        private residence (the firm zip stands in).
        """
        firm_record_raw = reference_metadata.get("firm_record")
        firm_record = firm_record_raw if isinstance(firm_record_raw, dict) else {}
        advisor_record_raw = reference_metadata.get("advisor_record")
        advisor_record = advisor_record_raw if isinstance(advisor_record_raw, dict) else {}

        if not display_name:
            return None, "no_name"
        if not zip_code:
            return None, "no_location"

        confirmed_profiles: list[dict[str, str]] = []
        if claim_type == "individual":
            anchor_crd = reference_metadata.get("individual_crd")
            anchor_url = _clean_text(advisor_record.get("report_url"))
        else:
            anchor_crd = reference_metadata.get("firm_crd")
            anchor_url = _clean_text(firm_record.get("report_url"))
        if anchor_crd not in (None, "") and anchor_url:
            confirmed_profiles.append(
                {
                    "platform": "SEC AdviserInfo",
                    "handle": str(anchor_crd),
                    "url": anchor_url,
                    "category": "Government/Regulatory",
                }
            )
        website = _ensure_url_scheme(_clean_text(firm_record.get("website")).lower())
        website_domain = firm_website_host(website)
        if website and website_domain:
            confirmed_profiles.append(
                {
                    "platform": "Firm website",
                    "handle": website_domain,
                    "url": website,
                    "category": "Professional",
                }
            )

        payload: dict[str, Any] = {
            "name": display_name,
            "email": email,
            "zipCode": zip_code,
            "consentAttestation": True,
            # The claim ceremony never asked for lifestyle/social-preference
            # consent; the dossier stays professional.
            "socialPreferenceConsent": False,
        }
        if confirmed_profiles:
            payload["confirmedProfiles"] = confirmed_profiles
        return payload, ""

    # ------------------------------------------------------------------
    # Intelligence scan HTTP (env-configured, key never logged)
    # ------------------------------------------------------------------

    @staticmethod
    def _scan_base_url() -> str:
        return _clean_text(os.getenv("INTELLIGENCE_API_BASE_URL")).rstrip("/")

    def _scan_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        api_key = _clean_text(os.getenv("INTELLIGENCE_API_KEY"))
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    async def _start_scan(self, payload: dict[str, Any]) -> tuple[str, str]:
        base_url = self._scan_base_url()
        if not base_url:
            return "", "not_configured"
        try:
            async with httpx.AsyncClient(
                timeout=30.0, transport=self._transport, headers=self._scan_headers()
            ) as client:
                response = await client.post(f"{base_url}/api/v1/scan", json=payload)
        except httpx.HTTPError as exc:
            logger.warning("ria.dossier_scan_request_failed error=%s", type(exc).__name__)
            return "", f"scan_request_failed:{type(exc).__name__}"
        if response.status_code != 202:
            return "", f"scan_start_status_{response.status_code}"
        try:
            parsed = response.json()
            body = parsed if isinstance(parsed, dict) else {}
        except ValueError:
            body = {}
        scan_id = _clean_text(body.get("scanId"))
        if not scan_id:
            return "", "scan_start_missing_id"
        return scan_id, ""

    async def _poll_scan(self, scan_id: str) -> tuple[str, str] | None:
        """Poll until completed/failed; None on failure or the hard cap."""
        base_url = self._scan_base_url()
        if not base_url:
            return None
        deadline = time.monotonic() + self._poll_cap_seconds
        while True:
            try:
                async with httpx.AsyncClient(
                    timeout=30.0, transport=self._transport, headers=self._scan_headers()
                ) as client:
                    response = await client.get(f"{base_url}/api/v1/scan/{scan_id}")
            except httpx.HTTPError as exc:
                logger.info("ria.dossier_scan_poll_failed error=%s", type(exc).__name__)
                response = None
            if response is not None and response.status_code == 200:
                try:
                    parsed = response.json()
                    body = parsed if isinstance(parsed, dict) else {}
                except ValueError:
                    body = {}
                status = _clean_text(body.get("status"))
                if status == "completed":
                    result_raw = body.get("result")
                    result = result_raw if isinstance(result_raw, dict) else {}
                    return str(result.get("report") or ""), str(result.get("summary") or "")
                if status == "failed":
                    return None
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(self._poll_interval_seconds)

    # ------------------------------------------------------------------
    # Mail hand-off (lane-independent: any fault is send_failed on the row)
    # ------------------------------------------------------------------

    async def _queue_mail(
        self, *, dossier_id: int, user_id: str, to_email: str, display_name: str
    ) -> None:
        try:
            # Lazy import: the mail lane ships independently; its absence is a
            # send failure on the row, never a worker crash.
            from hushh_mcp.services.ria_dossier_email_service import queue_dossier_email
        except ImportError:
            await self._update_row(
                dossier_id, completed=True, status="send_failed", error="mail_service_unavailable"
            )
            return

        def _value(result: Any, key: str) -> Any:
            if isinstance(result, dict):
                return result.get(key)
            return getattr(result, key, None)

        async def _mark_sent(result: Any) -> None:
            await self._update_row(
                dossier_id,
                completed=True,
                status="sent",
                mail_message_id=_value(result, "message_id"),
                mail_recipient=_value(result, "recipient"),
                mail_intended_recipient=_value(result, "intended_recipient") or to_email,
                mail_delivery_mode=_value(result, "delivery_mode"),
            )

        async def _mark_send_failed(exc: Exception) -> None:
            await self._update_row(
                dossier_id,
                completed=True,
                status="send_failed",
                error=str(exc) or type(exc).__name__,
            )

        try:
            outcome = await queue_dossier_email(
                user_id=user_id,
                to_email=to_email,
                first_name=display_name,
                on_success=_mark_sent,
                on_failure=_mark_send_failed,
            )
        except Exception as exc:  # noqa: BLE001 - the mail lane can never crash the worker
            logger.warning("ria.dossier_mail_enqueue_failed error=%s", type(exc).__name__)
            await _mark_send_failed(exc)
            return

        delivery_status = (
            _clean_text(outcome.get("delivery_status")) if isinstance(outcome, dict) else ""
        )
        reason = _clean_text(outcome.get("reason")) if isinstance(outcome, dict) else ""
        if delivery_status == "blocked":
            # The sender's fail-closed UAT guard: never mail a real adviser
            # by omission when the test redirect is unconfigured.
            await self._update_row(
                dossier_id,
                completed=True,
                status="send_blocked_test_unset",
                error=reason or "send_blocked_test_unset",
            )
        elif delivery_status == "failed":
            await self._update_row(
                dossier_id,
                completed=True,
                status="send_failed",
                error=reason or "enqueue_failed",
            )
        # "queued": the sender's on_success/on_failure callbacks decide.

    # ------------------------------------------------------------------
    # Row persistence
    # ------------------------------------------------------------------

    _UPDATABLE_COLUMNS = frozenset(
        {
            "status",
            "scan_id",
            "result_markdown",
            "result_summary",
            "error",
            "mail_message_id",
            "mail_recipient",
            "mail_intended_recipient",
            "mail_delivery_mode",
        }
    )

    async def _claim_generated(self, dossier_id: int, *, markdown: str, summary: str) -> bool:
        """Move `scanning` → `generated`, returning whether THIS worker won.

        A resumed poll can run alongside the original worker, and both would
        otherwise mail the same dossier. The transition is the lock: only a row
        still in `scanning` flips, so the loser mails nothing.
        """
        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    UPDATE ria_claim_dossiers
                       SET status = 'generated',
                           result_markdown = $2,
                           result_summary = $3
                     WHERE id = $1
                       AND status = 'scanning'
                       AND completed_at IS NULL
                 RETURNING id
                    """,
                    dossier_id,
                    markdown,
                    summary,
                )
        except asyncpg.UndefinedTableError:
            logger.warning("ria.dossier_table_missing")
            return False
        return row is not None

    async def _update_row(self, dossier_id: int, *, completed: bool = False, **fields: Any) -> None:
        assignments: list[str] = []
        values: list[Any] = [dossier_id]
        for column, value in fields.items():
            if column not in self._UPDATABLE_COLUMNS:
                raise ValueError(f"Refusing to update unknown dossier column: {column}")
            values.append(value)
            assignments.append(f"{column} = ${len(values)}")
        if completed:
            assignments.append("completed_at = NOW()")
        if not assignments:
            return
        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    # Column names are asserted against _UPDATABLE_COLUMNS above;
                    # every value is a bound parameter.
                    f"UPDATE ria_claim_dossiers SET {', '.join(assignments)} WHERE id = $1",  # nosec B608
                    *values,
                )
        except asyncpg.UndefinedTableError:
            logger.warning("ria.dossier_table_missing")
