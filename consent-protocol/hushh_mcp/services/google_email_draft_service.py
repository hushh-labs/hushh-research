"""Fast, structured draft generation for the visible email compose card.

It receives only the owner's current compose request. It has no Gmail token,
PKM export, or send capability; delivery remains in GoogleEmailDeliveryService.
"""

from __future__ import annotations

import json
from typing import Any

from hushh_mcp.services.google_connection_service import GoogleConnectionError

_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "to": {"type": "ARRAY", "items": {"type": "STRING"}},
        "cc": {"type": "ARRAY", "items": {"type": "STRING"}},
        "bcc": {"type": "ARRAY", "items": {"type": "STRING"}},
        "subject": {"type": "STRING"},
        "body": {"type": "STRING"},
        "missing_details": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["to", "cc", "bcc", "subject", "body", "missing_details"],
}


class GoogleEmailDraftService:
    async def draft(self, *, instruction: str) -> dict[str, Any]:
        clean = instruction.strip()
        if not clean:
            raise GoogleConnectionError("Describe the email you want to draft", status_code=422)
        from hushh_mcp.operons.kai import llm

        if not llm.is_gemini_ready():
            raise GoogleConnectionError(
                "Email drafting is temporarily unavailable", status_code=503
            )
        config = llm.build_kai_generation_config(
            llm.types,
            system_instruction=(
                "Draft a professional email from the owner's instruction. Return JSON only. "
                "Use only names, addresses, and facts explicitly present in the instruction. "
                "Never claim the email was sent. Leave missing values empty and list what is missing."
            ),
            response_mime_type="application/json",
            response_schema=_SCHEMA,
            temperature=0.2,
            max_output_tokens=1200,
        )
        response = await llm.agent_chat_model_call(
            [llm.types.Content(role="user", parts=[llm.types.Part(text=clean)])],
            config,
            attempt_timeout_s=8,
            total_timeout_s=20,
        )
        try:
            parsed = json.loads(str(getattr(response, "text", "") or "{}"))
        except json.JSONDecodeError as exc:
            raise GoogleConnectionError(
                "Email drafting returned an invalid response", status_code=502
            ) from exc
        if not isinstance(parsed, dict):
            raise GoogleConnectionError(
                "Email drafting returned an invalid response", status_code=502
            )
        return {
            "to": [str(item).strip() for item in parsed.get("to", []) if str(item).strip()][:60],
            "cc": [str(item).strip() for item in parsed.get("cc", []) if str(item).strip()][:60],
            "bcc": [str(item).strip() for item in parsed.get("bcc", []) if str(item).strip()][:60],
            "subject": str(parsed.get("subject") or "")[:512],
            "body": str(parsed.get("body") or "")[:20_000],
            "missing_details": [
                str(item).strip() for item in parsed.get("missing_details", []) if str(item).strip()
            ][:8],
        }


_singleton: GoogleEmailDraftService | None = None


def get_google_email_draft_service() -> GoogleEmailDraftService:
    global _singleton
    if _singleton is None:
        _singleton = GoogleEmailDraftService()
    return _singleton
