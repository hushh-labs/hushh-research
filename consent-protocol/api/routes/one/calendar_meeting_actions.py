"""Read-only meeting detail, provider file actions, and legacy chat context."""

from __future__ import annotations

import asyncio

from fastapi import HTTPException


async def meeting_detail(payload, response, firebase_uid, *, artifacts, http_error):
    response.headers["Cache-Control"] = "private, no-store"
    if not payload.date or not payload.time_zone:
        raise HTTPException(
            status_code=422, detail={"message": "Choose a meeting day and refresh."}
        )
    try:
        async with asyncio.timeout(38):
            return await artifacts(payload.account_id).detail(
                user_id=firebase_uid, **payload.model_dump(exclude={"account_id"})
            )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=504, detail={"message": "Meeting files took too long to check. Try again."}
        ) from exc
    except Exception as exc:
        raise http_error(exc) from exc


async def meeting_file_action(payload, response, firebase_uid, *, download, artifacts, http_error):
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    if (
        not payload.expected_grant
        or not payload.occurrence_id
        or not payload.date
        or not payload.time_zone
    ):
        raise HTTPException(
            status_code=422, detail={"message": "Refresh the meeting before downloading."}
        )
    try:
        async with asyncio.timeout(38):
            detail = await artifacts(payload.account_id).detail(
                user_id=firebase_uid,
                **payload.model_dump(exclude={"account_id", "file_id"}),
                content=False,
            )
        file = next(
            (
                item
                for item in detail["artifacts"]
                if item["file_id"] == payload.file_id and item["kind"] in {"recording", "notes"}
            ),
            None,
        )
        if not file or file.get("state") != "available":
            raise HTTPException(
                status_code=403,
                detail={"message": "This meeting file is no longer available to this account."},
            )
        if not download:
            if not file.get("url"):
                raise HTTPException(
                    status_code=503,
                    detail={"message": "Google did not provide an opening link for this file."},
                )
            return {"url": file["url"], "format": "open"}
        if not file.get("can_download"):
            raise HTTPException(
                status_code=403, detail={"message": "The file owner does not allow downloads."}
            )
        url = (
            file.get("pdf_export_url")
            if file.get("mime_type") == "application/vnd.google-apps.document"
            else file.get("download_url")
        )
        if not url:
            raise HTTPException(
                status_code=503,
                detail={
                    "message": "Google did not provide a download for this file. Open it in Drive."
                },
            )
        return {
            "url": url,
            "format": "pdf"
            if file.get("mime_type") == "application/vnd.google-apps.document"
            else "original",
        }
    except HTTPException:
        raise
    except TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail={"message": "Meeting file access took too long to check. Try again."},
        ) from exc
    except Exception as exc:
        raise http_error(exc) from exc


async def meeting_chat_context(payload, response, firebase_uid, *, artifacts, http_error):
    response.headers["Cache-Control"] = "private, no-store"
    try:
        detail = await artifacts(payload.account_id).detail(
            user_id=firebase_uid, **payload.model_dump(exclude={"account_id"}), for_chat=True
        )
        sources = [
            {
                "title": item["title"],
                "url": item["url"],
                "text": item["text"],
                "truncated": item.get("truncated", False),
            }
            for item in detail["artifacts"]
            if item.get("can_ask") and item.get("text")
        ]
        if not sources:
            raise HTTPException(
                status_code=403,
                detail={"message": "No meeting text is currently authorized for One."},
            )
        return {"title": detail["event"]["title"], "sources": sources}
    except HTTPException:
        raise
    except Exception as exc:
        raise http_error(exc) from exc
