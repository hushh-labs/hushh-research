# SPDX-License-Identifier: MIT
# Copyright (c) 2024 LangChain
"""EAIA gmail.py:112-124 and 147-149 at 758db7174223da7864feea7c9f8d1aba12923037.

Retains MIME reply construction and actual SDK send. Minimal adaptations: omit
From when `sender` is absent; preserve References chain; support Cc/Bcc. No auth,
recipient inference, loop, logging or fallback is imported. See ../PROVENANCE.md.
"""

import base64
import email.utils
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText


def create_message(
    sender,
    to,
    subject,
    message_text,
    thread_id,
    original_message_id,
    *,
    references=None,
    cc=None,
    bcc=None,
):
    message = MIMEMultipart()
    message["to"] = ", ".join(to)
    if sender:
        message["from"] = sender
    message["subject"] = subject
    message["In-Reply-To"] = original_message_id
    message["References"] = references or original_message_id
    message["Message-ID"] = email.utils.make_msgid()
    if cc:
        message["Cc"] = ", ".join(cc)
    if bcc:
        message["Bcc"] = ", ".join(bcc)
    msg = MIMEText(message_text)
    message.attach(msg)
    raw = base64.urlsafe_b64encode(message.as_bytes())
    raw = raw.decode()
    return {"raw": raw, "threadId": thread_id}


def send_message(service, user_id, message):
    message = service.users().messages().send(userId=user_id, body=message).execute()
    return message
