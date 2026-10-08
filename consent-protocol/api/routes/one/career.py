"""Career Agent: turn the owner's resume into a structured, reviewable draft.

  POST /api/one/career/resume/parse   (multipart: file = PDF or DOCX, <= 4 MB)
    -> {"resume": {...structured...}, "truncated": bool}

Vault-owner authenticated. The file is parsed in a resource-limited subprocess
with no credentials (IsolatedDocumentParser), and only the bounded text reaches
the manifest-owned Resume Extractor gene. NOTHING IS PERSISTED and no content is
logged: the structured resume goes back to the owner's device, which shows it
for review and encrypts it into their PKM (professional domain) with their own
vault key. Off unless ONE_CAREER_ENABLED.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile

from hushh_mcp.runtime_settings import one_career_enabled
from hushh_mcp.services.owner_placement_guard import hub_content_owner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/career", tags=["One Career"])

MAX_RESUME_BYTES = 4 * 1024 * 1024
_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_ALLOWED = {"application/pdf": "application/pdf", _DOCX: _DOCX}
_PARSE_MESSAGES = {
    "encrypted_document": "That PDF is password-protected. Export an unlocked copy and try again.",
    "no_extractable_text": "We couldn't find any text in that file. If it's a scan, try a text PDF or DOCX.",
    "file_too_large": "That file is over 4 MB. Try a smaller export.",
}


def _parser():
    from hushh_mcp.services.drive_document_processor import IsolatedDocumentParser

    return IsolatedDocumentParser()


async def _extract(*, text: str, user_id: str, consent_token: str) -> dict[str, Any]:
    from hushh_mcp.agents.career.runtime import extract_resume

    resume: dict[str, Any] = await extract_resume(
        text=text, user_id=user_id, consent_token=consent_token
    )
    return resume


@router.post("/resume/parse")
async def parse_resume(
    response: Response,
    file: UploadFile = File(...),
    token_data: dict = Depends(hub_content_owner),
) -> dict[str, Any]:
    if not one_career_enabled():
        raise HTTPException(status_code=404, detail="Not found")
    response.headers["Cache-Control"] = "private, no-store"

    mime = _ALLOWED.get((file.content_type or "").split(";")[0].strip().lower())
    if mime is None:
        raise HTTPException(
            status_code=415,
            detail={
                "code": "UNSUPPORTED_TYPE",
                "message": "Upload your resume as a PDF or Word (.docx) file.",
            },
        )
    content = await file.read(MAX_RESUME_BYTES + 1)
    if not content or len(content) > MAX_RESUME_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"code": "FILE_TOO_LARGE", "message": _PARSE_MESSAGES["file_too_large"]},
        )

    from hushh_mcp.services.google_drive_adapter import DriveReadError

    try:
        parsed = await _parser().parse(content=content, mime_type=mime)
    except DriveReadError as exc:
        code = str(getattr(exc, "code", "") or exc)
        raise HTTPException(
            status_code=422,
            detail={
                "code": "UNREADABLE_RESUME",
                "message": _PARSE_MESSAGES.get(
                    code, "We couldn't read that file. Try a different export."
                ),
            },
        ) from None
    finally:
        del content

    text = "\n".join(parsed.pages).strip()
    if not text:
        raise HTTPException(
            status_code=422,
            detail={"code": "UNREADABLE_RESUME", "message": _PARSE_MESSAGES["no_extractable_text"]},
        )
    try:
        resume = await _extract(
            text=text, user_id=token_data["user_id"], consent_token=token_data["token"]
        )
    except Exception:
        logger.warning("career.resume_extract_failed")
        raise HTTPException(
            status_code=503,
            detail={
                "code": "EXTRACTION_UNAVAILABLE",
                "message": "We couldn't read your resume right now. Try again shortly.",
            },
        ) from None
    return {"resume": resume, "truncated": bool(parsed.truncated)}
