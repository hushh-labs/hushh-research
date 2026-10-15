"""Requests people made to the owner in the UAT app, as the deployed backend stored them.

Read-only and owner-bound (``queries.STATEMENTS``): only requests where the owner
is ``drive_share_requests.user_id``. The requester is shown by display name only;
their email, subject and user id stay inside the sealed request and are never
returned. Whatever the backend did not store is marked "not recorded" instead of
being reconstructed.
"""

from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

NOT_RECORDED = "not recorded"
GRANT_KIND = "grant"
NO_NAME = "Requester (no display name)"
OUTCOME = {
    "succeeded": "shared",
    "preexisting": "already_had_access",
    "present_unattributed": "already_had_access",
    "failed": "failed",
    "absent": "failed",
    "skipped": "failed",
    "rejected": "failed",
    "not_dispatched": "failed",
    "needs_review": "failed",
    "queued": "pending",
    "dispatching": "pending",
    "unknown": "pending",
}
# Checkpoint fields that are search mechanics or provider handles, never shown.
HIDDEN_CHECKPOINT_KEYS = frozenset(
    {
        "drive_tokens",
        "drive_page_token",
        "page_token",
        "seen_tokens",
        "folder_digests",
        "folder_queue",
        "drives",
        "drive_index",
        "query_index",
        "request_origin_id",
    }
)
LOGS_NOTE = (
    "The deployed backend keeps no per-request log in its database, and this dashboard "
    "does not read Cloud Run logs (Cloud Run reads are describe-only)."
)


class RequestNotFound(LookupError):
    """No request with this id was made to the dashboard's owner."""


def _uuid(value) -> str | None:
    try:
        return str(UUID(str(value)))
    except ValueError:
        return None


def _iso(value):
    if isinstance(value, datetime | date):
        return value.isoformat()
    return value if isinstance(value, str) else None


def requester_name(value) -> str:
    from hushh_mcp.services.requester_identity import looks_technical_label

    text = str(value or "").strip()
    return NO_NAME if looks_technical_label(text) else text


def _label(record: dict | None) -> dict | None:
    if not record:
        return None
    return {
        "verdict": record.get("verdict"),
        "note": record.get("note") or "",
        "at": record.get("at"),
    }


class RealRequests:
    """The owner's incoming requests, list and detail, for the Real requests tab."""

    def __init__(self, reader, *, labels=None, cipher=None):
        self.reader = reader
        self.labels = labels
        self._cipher = cipher

    @property
    def cipher(self):
        if self._cipher is None:
            from hushh_mcp.services.drive_sharing_contract import DriveSharingCipher

            self._cipher = DriveSharingCipher()
        return self._cipher

    def _open(self, envelope, *, user_id, resource_id, purpose) -> dict | None:
        if not isinstance(envelope, dict):
            return None
        try:
            value = self.cipher.open(
                envelope, user_id=user_id, resource_id=resource_id, purpose=purpose
            )
        except Exception:  # noqa: BLE001 - an unreadable envelope is shown as not recorded
            return None
        return value if isinstance(value, dict) else None

    def _request_private(self, row) -> dict:
        return (
            self._open(
                row.get("request_envelope"),
                user_id=row["user_id"],
                resource_id=str(row["request_id"]),
                purpose="request",
            )
            or {}
        )

    def _labels(self, request_id: str | None = None) -> dict:
        if self.labels is None:
            return {}
        return self.labels.request_labels(request_id)

    # Header -------------------------------------------------------------------------
    def _header(self, row: dict, private: dict, label: dict | None) -> dict:
        purpose = private.get("purpose") if isinstance(private.get("purpose"), dict) else {}
        return {
            "request_id": str(row["request_id"]),
            "created_at": _iso(row.get("created_at")),
            "requester_display_name": requester_name(row.get("requester_display_name")),
            "purpose_text": purpose.get("purpose") if purpose else NOT_RECORDED,
            "period_start": purpose.get("periodStart"),
            "period_end": purpose.get("periodEnd"),
            "status": row.get("status"),
            "human_label": _label(label),
            "origin": "trusted_auto"
            if private.get("trusted_auto") is True
            else private.get("origin"),
            "agent_package": bool(row.get("agent_package_required")),
            "settlement_method": row.get("settlement_method"),
        }

    # List ---------------------------------------------------------------------------
    def list(self) -> list[dict]:
        from hushh_eval.drive_packets.dashboard.queries import REQUEST_LIMIT

        with self.reader.session() as db:
            rows = db.all("request_list", limit=REQUEST_LIMIT, grant_kind=GRANT_KIND)
        labels = self._labels()
        result = []
        for row in rows:
            request_id = str(row["request_id"])
            header = self._header(
                row, self._request_private(row), (labels.get(request_id) or {}).get(None)
            )
            files = int(row.get("shared_files") or 0) + int(row.get("ops_files") or 0)
            refund = row.get("refund_status")
            result.append(
                {
                    **header,
                    "selected_count": files if files else None,
                    "paid": row.get("order_status") == "paid" or row.get("paid_at") is not None,
                    "delivered": int(row.get("newly_shared") or 0)
                    + int(row.get("ops_shared") or 0),
                    "already_had_access": int(row.get("already_had_access") or 0)
                    + int(row.get("ops_already_had_access") or 0),
                    "amount_cents": row.get("order_amount_cents"),
                    "refunded": refund == "succeeded",
                    "refund_status": refund,
                    "stripe_mode": row.get("stripe_mode"),
                    "labels": len(labels.get(request_id) or {}),
                }
            )
        return result

    def canonical(self, request_id: str) -> str:
        """The canonical id of one of the owner's requests, else RequestNotFound."""
        identity = _uuid(request_id)
        if identity is None:
            raise RequestNotFound(request_id)
        with self.reader.session() as db:
            if db.one("request_exists", request_id=identity) is None:
                raise RequestNotFound(request_id)
        return identity

    # Detail -------------------------------------------------------------------------
    def detail(self, request_id: str) -> dict:
        identity = _uuid(request_id)
        if identity is None:
            raise RequestNotFound(request_id)
        with self.reader.session() as db:
            row = db.one("request_header", request_id=identity)
            if row is None:
                raise RequestNotFound(request_id)
            jobs = db.all("request_search_jobs", request_id=identity)
            results = db.all("request_search_results", request_id=identity) if jobs else []
            reviews = db.all("request_reviews", request_id=identity)
            shares = db.all("request_shares", request_id=identity)
            files = db.all("request_share_files", request_id=identity) if shares else []
            operations = db.all(
                "request_permission_operations", request_id=identity, grant_kind=GRANT_KIND
            )
            payment = db.one("request_payment", request_id=identity)
            payout = db.one("request_payout", request_id=identity)
            names = (
                db.all(
                    "document_names",
                    document_ids=sorted({str(item["document_id"]) for item in operations}),
                )
                if operations
                else []
            )
        private = self._request_private(row)
        labels = self._labels(identity)
        return self._detail(
            row,
            private,
            labels,
            jobs,
            results,
            reviews,
            shares,
            files,
            operations,
            payment,
            payout,
            names,
        )

    def _checkpoint(self, job) -> dict | None:
        return self._open(
            job.get("checkpoint_envelope"),
            user_id=job["user_id"],
            resource_id=str(job["job_id"]),
            purpose="owner-search-checkpoint",
        )

    @staticmethod
    def _plan(checkpoint: dict) -> dict:
        manifest = (
            checkpoint.get("coverage_manifest")
            if isinstance(checkpoint.get("coverage_manifest"), dict)
            else {}
        )
        arguments = (
            checkpoint.get("arguments") if isinstance(checkpoint.get("arguments"), dict) else {}
        )
        request = checkpoint.get("request") if isinstance(checkpoint.get("request"), dict) else {}
        package = (
            checkpoint.get("agent_package")
            if isinstance(checkpoint.get("agent_package"), dict)
            else None
        )
        stored = {
            key: value
            for key, value in checkpoint.items()
            if key not in HIDDEN_CHECKPOINT_KEYS
            and key not in {"coverage_manifest", "arguments", "request", "queries", "agent_package"}
        }
        return {
            "request_text": request.get("query", NOT_RECORDED),
            "drive_query": arguments.get("query", NOT_RECORDED),
            "order_by": arguments.get("orderBy", NOT_RECORDED),
            "queries": [
                (item.get("arguments") or {}).get("query")
                for item in checkpoint.get("queries") or []
                if isinstance(item, dict)
            ],
            "file_kind": checkpoint.get("request_file_kind", NOT_RECORDED),
            "subject_terms": checkpoint.get("request_subject_terms", NOT_RECORDED),
            "explicit_dates": checkpoint.get("request_explicit_dates", NOT_RECORDED),
            "requested_period": checkpoint.get("requested_period", NOT_RECORDED),
            "date_basis": manifest.get("dateBasis", NOT_RECORDED),
            "content_period_verified": manifest.get("contentPeriodVerified", NOT_RECORDED),
            "result_limit": checkpoint.get("request_result_limit"),
            "coverage": {
                key: value
                for key, value in manifest.items()
                if key
                in {
                    "corpora",
                    "fileKind",
                    "folderDiscovery",
                    "orderBy",
                    "shortcutDiscovery",
                    "resultLimit",
                    "fallbackReason",
                }
            },
            "package": {
                "decision": ((package or {}).get("assessment") or {}).get("decision"),
                "coverage_status": ((package or {}).get("assessment") or {}).get("coverage_status"),
                "coverage_summary": ((package or {}).get("assessment") or {}).get(
                    "coverage_summary"
                ),
                "gaps": ((package or {}).get("assessment") or {}).get("gaps"),
                "selected_positions": (package or {}).get("selected_positions"),
                "counts": (package or {}).get("counts"),
                "suggested_price_cents": ((package or {}).get("assessment") or {}).get(
                    "suggested_price_cents"
                ),
            }
            if package
            else NOT_RECORDED,
            "other_stored_fields": sorted(stored),
            "stored": {
                key: stored[key]
                for key in sorted(stored)
                if isinstance(stored[key], str | int | float | bool) or stored[key] is None
            },
        }

    def _detail(
        self,
        row,
        private,
        labels,
        jobs,
        results,
        reviews,
        shares,
        files,
        operations,
        payment,
        payout,
        names,
    ):
        header = self._header(row, private, labels.get(None))
        checkpoints = [(job, self._checkpoint(job)) for job in jobs]
        multi = len(jobs) > 1
        job_index = {str(job["job_id"]): index for index, job in enumerate(jobs, start=1)}

        def doc_key(job_id, position) -> str:
            return f"j{job_index.get(str(job_id), 0)}p{position}" if multi else f"p{position}"

        # Files the backend shared (or tried to): bulk share files and older per-file operations.
        delivered: dict[str, dict] = {}
        for item in files:
            metadata = (
                self._open(
                    item.get("metadata_envelope"),
                    user_id=item["user_id"],
                    resource_id=f"{item['source_job_id']}:{item['source_position']}",
                    purpose="owner-search-result",
                )
                or {}
            )
            key = doc_key(item["source_job_id"], item["source_position"])
            entry = delivered.setdefault(
                key,
                {"file_name": metadata.get("name") or NOT_RECORDED, "states": [], "errors": []},
            )
            if item.get("state"):
                entry["states"].append(item["state"])
            if item.get("safe_error_code"):
                entry["errors"].append(item["safe_error_code"])
        name_of = {}
        if names:
            from hushh_mcp.services.drive_document_store import DriveDocumentCipher

            cipher = DriveDocumentCipher()
            for item in names:
                try:
                    name_of[str(item["document_id"])] = (cipher.open(dict(item)) or {}).get("name")
                except Exception:  # noqa: BLE001 - unreadable metadata stays unnamed
                    continue
        for item in operations:
            key = f"d:{item['document_id']}"
            entry = delivered.setdefault(
                key,
                {
                    "file_name": name_of.get(str(item["document_id"])) or NOT_RECORDED,
                    "states": [],
                    "errors": [],
                },
            )
            entry["states"].append(item.get("state"))
            if item.get("safe_error_code"):
                entry["errors"].append(item["safe_error_code"])

        def outcome(states: list) -> str:
            mapped = [OUTCOME.get(state, "failed") for state in states if state]
            for value in ("shared", "already_had_access", "pending", "failed"):
                if value in mapped:
                    return value
            return NOT_RECORDED

        delivery = [
            {
                "document_id": key,
                "file_name": entry["file_name"],
                "outcome": outcome(entry["states"]),
                "states": sorted(set(filter(None, entry["states"]))),
                "errors": sorted(set(entry["errors"])),
            }
            for key, entry in delivered.items()
        ]

        # Documents the search kept, with whatever evaluation the backend stored.
        package_selected = set()
        for job, checkpoint in checkpoints:
            package = (checkpoint or {}).get("agent_package")
            if isinstance(package, dict):
                package_selected |= {
                    doc_key(job["job_id"], p) for p in package.get("selected_positions") or []
                }
        documents = []
        rows = []
        for item in results:
            metadata = (
                self._open(
                    item.get("metadata_envelope"),
                    user_id=item["user_id"],
                    resource_id=f"{item['job_id']}:{item['position']}",
                    purpose="owner-search-result",
                )
                or {}
            )
            evaluation = (
                self._open(
                    item.get("evaluation_envelope"),
                    user_id=item["user_id"],
                    resource_id=f"{item['job_id']}:{item['position']}",
                    purpose="request-package-evidence",
                )
                if item.get("evaluation_envelope")
                else None
            )
            assessment = (evaluation or {}).get("assessment") or {}
            periods = [
                period
                for period in assessment.get("covered_periods") or []
                if isinstance(period, dict)
                and period.get("period_start")
                and period.get("period_end")
            ]
            citations = [c for c in assessment.get("citations") or [] if isinstance(c, dict)]
            key = doc_key(item["job_id"], item["position"])
            selected = key in delivered or key in package_selected
            flags = []
            if selected and not periods:
                flags.append("selected_without_content_dates")
            if evaluation is None:
                flags.append("no_content_evaluation_stored")
            label = labels.get(key)
            documents.append(
                {
                    "document_id": key,
                    "file_name": metadata.get("name") or NOT_RECORDED,
                    "mime": metadata.get("mimeType"),
                    "modified_time": metadata.get("modifiedTime"),
                    "created_time": metadata.get("createdTime"),
                    "selected": selected,
                    "decision": assessment.get("decision") or NOT_RECORDED,
                    "reason": assessment.get("reason")
                    or (evaluation or {}).get("unreadable_reason")
                    or NOT_RECORDED,
                    "confidence": assessment.get("confidence"),
                    "period_start": min((p["period_start"] for p in periods), default=None),
                    "period_end": max((p["period_end"] for p in periods), default=None),
                    "period_role": "content_period" if periods else NOT_RECORDED,
                    "evidence_quote": citations[0].get("quote") if citations else None,
                    "page": None,
                    "indexed_evidence": bool((evaluation or {}).get("indexed_evidence")),
                    "flags": flags,
                    "delivery": outcome(delivered[key]["states"]) if key in delivered else None,
                    "human_label": _label(label),
                }
            )
            rows.append(
                {
                    "file_name": metadata.get("name") or NOT_RECORDED,
                    "mime": metadata.get("mimeType"),
                    "modified_time": metadata.get("modifiedTime"),
                    "created_time": metadata.get("createdTime"),
                    "kept": True,
                    "drop_stage": None,
                    "drop_reason": None,
                }
            )

        calls, plan, dropped = [], NOT_RECORDED, {}
        for job, checkpoint in checkpoints:
            counts = (checkpoint or {}).get("coverage_counts") or {}
            arguments = (checkpoint or {}).get("arguments") or {}
            calls.append(
                {
                    "q": arguments.get("query", NOT_RECORDED),
                    "order_by": arguments.get("orderBy"),
                    "pages": counts.get("providerFilePages", job.get("pages_scanned")),
                    "rows": counts.get("providerRowsScanned", NOT_RECORDED),
                    "kept": job.get("matched"),
                    "ms": NOT_RECORDED,
                    "incomplete_search": job.get("incomplete_search"),
                    "error": job.get("error_code"),
                }
            )
            for name, value in counts.items():
                if name.startswith("excluded") and isinstance(value, int):
                    dropped[name] = dropped.get(name, 0) + value
            if checkpoint is not None:
                plan = self._plan(checkpoint)

        steps = [
            {
                "name": "request created",
                "at": _iso(row.get("created_at")),
                "notes": header["origin"] or "",
            }
        ]
        if row.get("owner_allowed_at"):
            allowed = (
                private.get("owner_allowed")
                if isinstance(private.get("owner_allowed"), dict)
                else {}
            )
            steps.append(
                {
                    "name": "owner allowed",
                    "at": _iso(row.get("owner_allowed_at")),
                    "notes": f"price {allowed.get('amount_cents', row.get('quoted_amount_cents'))} cents"
                    + ("; Trusted auto-approval" if private.get("trusted_auto") else ""),
                }
            )
        for job, checkpoint in checkpoints:
            counts = (checkpoint or {}).get("coverage_counts") or {}
            scanned = counts.get("providerRowsScanned")
            steps.append(
                {
                    "name": "Drive search",
                    "at": _iso(job.get("created_at")),
                    "finished_at": _iso(job.get("updated_at")),
                    "in": scanned if isinstance(scanned, int) else NOT_RECORDED,
                    "kept": job.get("matched"),
                    "dropped": (scanned - job["matched"])
                    if isinstance(scanned, int) and isinstance(job.get("matched"), int)
                    else NOT_RECORDED,
                    "notes": f"status {job.get('status')}; {job.get('pages_scanned')} result pages"
                    + (f"; error {job['error_code']}" if job.get("error_code") else ""),
                }
            )
            steps.append(
                {
                    "name": "content evaluation",
                    "at": _iso(job.get("updated_at")),
                    "notes": f"status {job.get('evaluation_status')}"
                    + (
                        f"; error {job['evaluation_error_code']}"
                        if job.get("evaluation_error_code")
                        else ""
                    )
                    + (
                        ""
                        if row.get("agent_package_required")
                        else "; this request did not need a content package"
                    ),
                }
            )
        for review in reviews:
            steps.append(
                {
                    "name": "owner review",
                    "at": _iso(review.get("created_at")),
                    "notes": f"decision {review.get('decision') or 'none yet'}"
                    + (f" at {_iso(review.get('decided_at'))}" if review.get("decided_at") else ""),
                }
            )
        for share in shares:
            steps.append(
                {
                    "name": "share batch",
                    "at": _iso(share.get("created_at")),
                    "finished_at": _iso(share.get("updated_at")),
                    "in": share.get("file_count"),
                    "notes": f"status {share.get('status')}; approved by {share.get('approval_source') or NOT_RECORDED}",
                }
            )
        if payment:
            steps.append(
                {
                    "name": "payment",
                    "at": _iso(payment.get("created_at")),
                    "finished_at": _iso(payment.get("paid_at")),
                    "notes": f"order {payment.get('status')} ({payment.get('stripe_mode') or 'mode not recorded'})",
                }
            )
            if payment.get("refund_status"):
                steps.append(
                    {
                        "name": "refund",
                        "at": _iso(payment.get("refund_created_at")),
                        "notes": f"refund {payment['refund_status']}",
                    }
                )
        if delivery:
            tally: dict[str, int] = {}
            for item in delivery:
                tally[item["outcome"]] = tally.get(item["outcome"], 0) + 1
            steps.append(
                {
                    "name": "delivery",
                    "at": None,
                    "kept": tally.get("shared", 0),
                    "notes": ", ".join(f"{count} {name}" for name, count in sorted(tally.items())),
                }
            )
        steps.append(
            {
                "name": "request status",
                "at": _iso(row.get("updated_at")),
                "notes": str(row.get("status")),
            }
        )

        owner_review = self._owner_review(row, private, reviews, delivery, checkpoints)
        refund = (payment or {}).get("refund_status")
        detail = {
            **header,
            "selected_count": len(delivery) if delivery else (len(package_selected) or None),
            "paid": bool(payment and (payment.get("status") == "paid" or payment.get("paid_at"))),
            "delivered": sum(item["outcome"] == "shared" for item in delivery),
            "already_had_access": sum(item["outcome"] == "already_had_access" for item in delivery),
            "plan": plan,
            "drive_api": {
                "calls": calls or NOT_RECORDED,
                "rows": rows if jobs else NOT_RECORDED,
                "rows_note": "Only the rows the backend kept are stored; dropped rows were not recorded."
                if jobs
                else "No Drive search record is stored for this request (purged or never run).",
                "dropped": dropped,
            },
            "steps": steps,
            "documents": documents,
            "owner_review": owner_review,
            "payment": {
                "status": (payment or {}).get("status", NOT_RECORDED),
                "amount_cents": (payment or {}).get("amount_cents"),
                "refunded": refund == "succeeded",
                "refund_status": refund,
                "refund_amount_cents": (payment or {}).get("refund_amount_cents"),
                "stripe_mode": (payment or {}).get("stripe_mode"),
                "settlement_method": (payment or {}).get("settlement_method")
                or row.get("settlement_method"),
                "paid_at": _iso((payment or {}).get("paid_at")),
                "reconciliation_reason": (payment or {}).get("reconciliation_reason"),
                "owner_payout": {
                    "status": payout.get("status"),
                    "expected_files": payout.get("expected_files"),
                    "confirmed_files": payout.get("confirmed_files"),
                    "owner_earning_cents": payout.get("owner_earning_cents"),
                    "credited_at": _iso(payout.get("credited_at")),
                }
                if payout
                else NOT_RECORDED,
            }
            if payment
            else {"status": NOT_RECORDED, "amount_cents": None, "refunded": False},
            "delivery": delivery,
            "logs": NOT_RECORDED,
            "logs_note": LOGS_NOTE,
            "labels": {
                str(key) if key is not None else "overall": _label(value)
                for key, value in labels.items()
            },
        }
        return detail

    def _owner_review(self, row, private, reviews, delivery, checkpoints) -> dict:
        allowed = (
            private.get("owner_allowed") if isinstance(private.get("owner_allowed"), dict) else {}
        )
        price = allowed.get("amount_cents", row.get("quoted_amount_cents"))
        if reviews:
            review = reviews[-1]
            payload = (
                self._open(
                    review.get("review_envelope"),
                    user_id=review["user_id"],
                    resource_id=f"{review['request_id']}:{review['revision']}",
                    purpose="review",
                )
                or {}
            )
            coverage = payload.get("coverage")
            return {
                "kind": "owner_review",
                "files": [
                    {"file_name": item.get("name"), "period_start": None, "period_end": None}
                    for item in payload.get("files") or []
                    if isinstance(item, dict)
                ],
                "coverage_text": coverage
                if isinstance(coverage, str)
                else (coverage and str(coverage)) or NOT_RECORDED,
                "price_cents": price,
                "decision": review.get("decision") or "none yet",
                "decided_at": _iso(review.get("decided_at")),
            }
        package = next(
            (
                (checkpoint or {}).get("agent_package")
                for _, checkpoint in reversed(checkpoints)
                if isinstance((checkpoint or {}).get("agent_package"), dict)
            ),
            None,
        )
        if package:
            assessment = package.get("assessment") or {}
            return {
                "kind": "agent_package",
                "files": [
                    {"file_name": item["file_name"], "period_start": None, "period_end": None}
                    for item in delivery
                ],
                "coverage_text": assessment.get("coverage_summary") or NOT_RECORDED,
                "price_cents": price
                if price is not None
                else assessment.get("suggested_price_cents"),
                "decision": "allowed" if row.get("owner_allowed_at") else "not allowed yet",
                "decided_at": _iso(row.get("owner_allowed_at")),
            }
        return {
            "kind": "trusted_auto" if private.get("trusted_auto") else "none",
            "files": [
                {"file_name": item["file_name"], "period_start": None, "period_end": None}
                for item in delivery
            ],
            "coverage_text": NOT_RECORDED,
            "price_cents": price,
            "decision": "approved automatically (Trusted circle); no owner review was stored"
            if private.get("trusted_auto")
            else NOT_RECORDED,
            "decided_at": _iso(row.get("owner_allowed_at")),
        }
