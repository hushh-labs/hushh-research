"""Encrypted extraction checkpoints, called inside the ingestion job fence.

These synchronous transaction helpers have no independent consent authority.
The caller must lock/validate its current ingestion job before every call.
"""

from __future__ import annotations

import base64
import json
import secrets
from dataclasses import asdict

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text

from hushh_mcp.services.document_index_service import index_version
from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE, ExtractedPages, PageEvidence
from hushh_mcp.services.drive_document_store import DriveDocumentCipher
from hushh_mcp.services.google_drive_adapter import DriveReadError


class DriveDocumentPageStore:
    def __init__(self, *, cipher=None):
        self.cipher = cipher or DriveDocumentCipher()

    @staticmethod
    def _parameters(job, source_version, profile=EXTRACTION_PROFILE):
        return {
            "document": str(job["document_id"]),
            "user": job["user_id"],
            "generation": job["connection_generation"],
            "source": source_version,
            "version": index_version(
                source_fingerprint=job["source_fingerprint"],
                source_version=source_version,
                profile=profile,
            ),
            "profile": profile,
        }

    @staticmethod
    def _aad(params, number):
        return json.dumps(
            [
                "drive-document-page-v1",
                params["user"],
                params["document"],
                params["generation"],
                params["version"],
                number,
            ]
        ).encode()

    def progress(self, connection, job, source_version):
        params = self._parameters(job, source_version)
        row = (
            connection.execute(
                text("""
            SELECT extraction_version, next_page, total_pages, complete, has_gaps,
                   unit_kind, extraction_profile, engine_versions
            FROM drive_document_extractions
            WHERE document_id=:document AND user_id=:user
              AND connection_generation=:generation AND extraction_version=:version
        """),
                params,
            )
            .mappings()
            .first()
        )
        return (
            dict(row)
            if row
            else {
                "next_page": 1,
                "total_pages": None,
                "complete": False,
                "has_gaps": False,
                "extraction_version": params["version"],
                "extraction_profile": EXTRACTION_PROFILE,
            }
        )

    def commit(self, connection, job, source_version, batch: ExtractedPages):
        batch.validate()
        params = self._parameters(job, source_version, batch.profile)
        previous = self.progress(connection, job, source_version)
        if previous["complete"] or previous["next_page"] != batch.pages[0].page_number:
            raise DriveReadError("ingestion_superseded")
        # A render-policy marker can be added while resuming unchanged native
        # pages; parser/OCR versions must still match and existing gaps persist.
        if previous["total_pages"] is not None and (
            previous["total_pages"] != batch.total_pages
            or previous["unit_kind"] != batch.unit_kind
            or previous["engine_versions"].get("render_policy")
            not in (None, batch.engine_versions.get("render_policy"))
            or {k: v for k, v in previous["engine_versions"].items() if k != "render_policy"}
            != {k: v for k, v in batch.engine_versions.items() if k != "render_policy"}
        ):
            raise DriveReadError("source_changed", retryable=True)
        gaps = previous["has_gaps"] or batch.has_gaps
        connection.execute(
            text("""
            INSERT INTO drive_document_extractions
              (document_id,user_id,connection_generation,source_version,extraction_version,
               extraction_profile,next_page,total_pages,complete,has_gaps,unit_kind,engine_versions)
            VALUES (:document,:user,:generation,:source,:version,:profile,:next,:total,:complete,
                    :gaps,:unit,CAST(:engines AS jsonb))
            ON CONFLICT(document_id,extraction_version) DO UPDATE SET
              next_page=EXCLUDED.next_page, complete=EXCLUDED.complete,
              has_gaps=EXCLUDED.has_gaps, engine_versions=EXCLUDED.engine_versions,
              updated_at=clock_timestamp(),
              completed_at=CASE WHEN EXCLUDED.complete THEN clock_timestamp() ELSE NULL END
        """),
            {
                **params,
                "next": batch.next_page,
                "total": batch.total_pages,
                "complete": batch.complete,
                "gaps": gaps,
                "unit": batch.unit_kind,
                "engines": json.dumps(batch.engine_versions),
            },
        )
        for page in batch.pages:
            nonce = secrets.token_bytes(12)
            envelope = {
                "version": 1,
                "iv": base64.b64encode(nonce).decode(),
                "ciphertext": base64.b64encode(
                    AESGCM(self.cipher._key()).encrypt(
                        nonce,
                        json.dumps(asdict(page), separators=(",", ":")).encode(),
                        self._aad(params, page.page_number),
                    )
                ).decode(),
            }
            connection.execute(
                text("""
                INSERT INTO drive_document_pages
                  (document_id,extraction_version,page_number,content_envelope)
                VALUES (:document,:version,:page,CAST(:envelope AS jsonb))
            """),
                {**params, "page": page.page_number, "envelope": json.dumps(envelope)},
            )
        if batch.complete:
            count = connection.execute(
                text("""
                SELECT count(*) FROM drive_document_pages
                WHERE document_id=:document AND extraction_version=:version
            """),
                params,
            ).scalar_one()
            if count != batch.total_pages:
                raise DriveReadError("index_response_invalid")
            connection.execute(
                text("""
                UPDATE drive_document_extractions SET completed_at=clock_timestamp()
                WHERE document_id=:document AND extraction_version=:version
            """),
                params,
            )
        return self.progress(connection, job, source_version)

    def read(
        self, connection, job, source_version, *, after_page=0, limit=4, require_complete=True
    ):
        if type(after_page) is not int or after_page < 0 or not 1 <= limit <= 32:
            raise DriveReadError("invalid_argument")
        progress = self.progress(connection, job, source_version)
        if require_complete and not progress["complete"]:
            raise DriveReadError("source_unavailable")
        params = self._parameters(job, source_version)
        rows = connection.execute(
            text("""
            SELECT page_number, content_envelope FROM drive_document_pages
            WHERE document_id=:document AND extraction_version=:version
              AND page_number>:after ORDER BY page_number LIMIT :limit
        """),
            {**params, "after": after_page, "limit": limit},
        ).mappings()
        pages = []
        for row in rows:
            try:
                envelope = row["content_envelope"]
                if envelope["version"] != 1:
                    raise ValueError("invalid envelope")
                payload = AESGCM(self.cipher._key()).decrypt(
                    base64.b64decode(envelope["iv"], validate=True),
                    base64.b64decode(envelope["ciphertext"], validate=True),
                    self._aad(params, row["page_number"]),
                )
                page = PageEvidence(**json.loads(payload))
                if page.page_number != row["page_number"]:
                    raise ValueError("invalid page")
                pages.append(page)
            except Exception:
                raise DriveReadError("document_storage_unavailable") from None
        return {**progress, "pages": tuple(pages)}
