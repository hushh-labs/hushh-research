"""GET/POST /api/account/legal-acceptance: the person's Terms and Privacy acceptance.

Firebase-authenticated, not vault-gated: acceptance is recorded at sign-in, before
a vault exists. The account id comes only from the verified token; the body never
names a user.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, field_validator

from api.middleware import require_firebase_auth, require_firebase_auth_read_only
from hushh_mcp.services import legal_acceptance_service
from hushh_mcp.services.legal_acceptance_service import (
    AcceptedDocument,
    LegalAcceptanceSurface,
    LegalDocumentId,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Version labels such as "2.0", "2026-09-27" or "February 2026".
_VERSION_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 .:/()_-]{0,63}$")
_REQUIRED_DOCUMENTS: frozenset[str] = frozenset({"terms", "privacy"})


class LegalDocumentVersionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: LegalDocumentId
    document_version: str = Field(min_length=1, max_length=64)
    effective_date: str = Field(min_length=1, max_length=64)

    @field_validator("document_version", "effective_date")
    @classmethod
    def _label(cls, value: str) -> str:
        if not _VERSION_LABEL.fullmatch(value):
            raise ValueError("must be a short version or date label")
        return value


class LegalAcceptanceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    documents: list[LegalDocumentVersionIn] = Field(min_length=2, max_length=2)
    surface: LegalAcceptanceSurface

    @field_validator("documents")
    @classmethod
    def _both_documents_once(
        cls, value: list[LegalDocumentVersionIn]
    ) -> list[LegalDocumentVersionIn]:
        if {document.document_id for document in value} != _REQUIRED_DOCUMENTS:
            raise ValueError("must list the terms and privacy documents exactly once each")
        return value


@router.get("/legal-acceptance")
async def get_legal_acceptance(
    firebase_uid: str = Depends(require_firebase_auth_read_only),
):
    """Latest accepted version of each legal document; empty when none recorded."""
    acceptances = await legal_acceptance_service.list_latest_acceptances(user_id=firebase_uid)
    return {"acceptances": acceptances}


@router.post("/legal-acceptance")
async def record_legal_acceptance(
    request: LegalAcceptanceRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """Record acceptance of the listed versions. Idempotent per version."""
    acceptances = await legal_acceptance_service.record_acceptances(
        user_id=firebase_uid,
        documents=[
            AcceptedDocument(
                document_id=document.document_id,
                document_version=document.document_version,
                effective_date=document.effective_date,
            )
            for document in request.documents
        ],
        surface=request.surface,
    )
    logger.info("account.legal_acceptance_recorded surface=%s", request.surface)
    return {"acceptances": acceptances}
