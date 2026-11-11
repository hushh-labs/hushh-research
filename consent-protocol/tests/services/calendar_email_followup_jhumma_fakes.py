"""Synthetic Gmail provider bodies for the frozen-clock Jhumma lifecycle test."""

from __future__ import annotations

import base64
from datetime import UTC, datetime

import httpx

DOCUMENT_QUOTE = "Please send the document before 26 October"
MEETING_QUOTE = "Could we have a call on 27 October"
CORRECTION_QUOTE = "The document deadline is now 28 October"


def _mock_messages() -> dict:
    paragraphs = [
        "Hello, here is the research context for our discussion.",
        "The first section concerns the project scope and participants.",
        "The second section covers the draft materials and review process.",
        "We can continue by email while the materials are prepared.",
        f"{DOCUMENT_QUOTE}. {MEETING_QUOTE}? Please let me know a suitable time.",
    ]
    original_body = "\n\n".join(paragraphs)
    correction_body = f"A quick correction: {CORRECTION_QUOTE}. The proposed call is unchanged."
    return {
        "msg-jhumma": (original_body, datetime(2026, 10, 10, 12, tzinfo=UTC)),
        "msg-correction": (correction_body, datetime(2026, 10, 20, 12, tzinfo=UTC)),
    }


def _response(request: httpx.Request, provider: dict, messages: dict) -> httpx.Response:
    path = request.url.path
    if path.endswith("/profile"):
        return httpx.Response(200, json={"historyId": "100"})
    if path.endswith("/messages"):
        return httpx.Response(
            200, json={"messages": [{"id": "msg-jhumma", "threadId": "thread-jhumma"}]}
        )
    if path.endswith("/history"):
        changed = provider["corrected"] and request.url.params.get("startHistoryId") == "100"
        return httpx.Response(
            200,
            json={
                "historyId": "101" if provider["corrected"] else "100",
                "history": [
                    {
                        "messagesAdded": [
                            {
                                "message": {
                                    "id": "msg-correction",
                                    "threadId": "thread-jhumma",
                                }
                            }
                        ]
                    }
                ]
                if changed
                else [],
            },
        )
    if path.endswith("/threads/thread-jhumma"):
        ids = ["msg-jhumma", "msg-correction"] if provider["corrected"] else ["msg-jhumma"]
        return httpx.Response(
            200,
            json={
                "id": "thread-jhumma",
                "messages": [
                    {
                        "id": mid,
                        "threadId": "thread-jhumma",
                        "internalDate": str(int(messages[mid][1].timestamp() * 1000)),
                        "labelIds": ["INBOX"],
                    }
                    for mid in ids
                ],
            },
        )
    for mid, (body, received) in messages.items():
        if path.endswith("/messages/" + mid):
            if provider["deleted"] and mid == "msg-jhumma":
                return httpx.Response(404)
            provider["read_ids"].append(mid)
            return httpx.Response(
                200,
                json={
                    "id": mid,
                    "threadId": "thread-jhumma",
                    "internalDate": str(int(received.timestamp() * 1000)),
                    "payload": {
                        "mimeType": "text/plain",
                        "body": {
                            "data": base64.urlsafe_b64encode(body.encode()).decode().rstrip("="),
                            "size": len(body.encode()),
                        },
                        "headers": [
                            {"name": "Subject", "value": "Research document and call"},
                            {"name": "From", "value": "Jhumma <jhumma@example.test>"},
                        ],
                    },
                },
            )
    return httpx.Response(404)
