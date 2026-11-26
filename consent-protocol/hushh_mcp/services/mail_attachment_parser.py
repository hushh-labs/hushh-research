"""Use the qualified isolated attachment parser for this deployment."""

import os


async def parse_mail_attachment(content: bytes, mime_type: str):
    if os.getenv("HUSHH_DEPLOY_ENV") == "uat":
        from hushh_mcp.services.email_oss.attachment_worker import WorkerAttachmentParser

        worker = WorkerAttachmentParser()
        return await worker(content=content, mime_type=mime_type)
    else:
        from hushh_mcp.services.drive_document_processor import (
            ClamAvScanner,
            IsolatedDocumentParser,
        )

        await ClamAvScanner().scan(content)
        return await IsolatedDocumentParser().parse(content=content, mime_type=mime_type, live=True)
