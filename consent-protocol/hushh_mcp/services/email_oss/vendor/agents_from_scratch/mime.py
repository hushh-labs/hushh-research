# SPDX-License-Identifier: MIT
# Copyright (c) 2026 LangChain, Inc.
"""Verbatim extract_message_part from gmail_tools.py:43-61 at
603fc7a4ac6119004f43894395e504a1fefcc6c0, extracted from its optional-import block.
The caller supplies a bounded, padded, attachment-free MIME projection and owns
HTML-to-text cleaning. No demo authentication, mocks or logging are imported.
"""

import base64


def extract_message_part(payload):
    """Extract content from a message part."""
    if payload.get("body", {}).get("data"):
        # Handle base64 encoded content
        data = payload["body"]["data"]
        decoded = base64.urlsafe_b64decode(data).decode("utf-8")
        return decoded

    # Handle multipart messages
    if payload.get("parts"):
        text_parts = []
        for part in payload["parts"]:
            # Recursively process parts
            content = extract_message_part(part)
            if content:
                text_parts.append(content)
        return "\n".join(text_parts)

    return ""
