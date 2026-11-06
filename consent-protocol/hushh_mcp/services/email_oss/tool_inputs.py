"""Closed schemas for the authored Email tool catalog."""

from pydantic import BaseModel, ConfigDict, Field

from .accounting import ReceiptAmount


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Search(_Input):
    q: str = Field(
        min_length=1,
        max_length=1024,
        description="Preserve every user-requested sender and time boundary using native Gmail search operators and the authenticated owner clock and timezone. Add only requested constraints; never substitute a default lookback.",
    )
    max_results: int = Field(default=25, ge=1, le=50)
    page_token: str | None = Field(default=None, max_length=2048)
    include_clean_body: bool = Field(
        default=False,
        description="Set true for requested receipt amounts, totals or message contents when a bounded result page needs body text. For query-and-list or a series timeline using subject and received date, use false; read only selected messages afterward when their contents matter. Preserve native provider ordering in the search result.",
    )


class _Message(_Input):
    message_id: str = Field(min_length=1, max_length=256)


class _Thread(_Input):
    thread_id: str = Field(min_length=1, max_length=256)


class _Attachment(_Message):
    attachment_id: str = Field(min_length=1, max_length=4096)


class _Envelope(_Input):
    to: list[str] | str
    subject: str = Field(max_length=256)
    body: str = Field(min_length=1, max_length=12000)
    cc: list[str] | None = None
    bcc: list[str] | None = None


class _DraftEnvelope(_Envelope):
    html_body: str | None = Field(default=None, max_length=50000)


class _Reply(_Input):
    thread_id: str | None = Field(default=None, min_length=1, max_length=256)
    to: list[str] | str | None = None
    body: str = Field(min_length=1, max_length=12000)
    message_id: str | None = Field(default=None, max_length=256)
    subject: str | None = Field(default=None, max_length=256)
    cc: list[str] | None = None
    bcc: list[str] | None = None


class _Modify(_Input):
    message_ids: list[str] = Field(min_length=1, max_length=25)
    add_label_ids: list[str] | None = Field(default=None, max_length=25)
    remove_label_ids: list[str] | None = Field(default=None, max_length=25)


class _ReadMemory(_Input):
    section_or_query: str = Field(default="", max_length=200)


class _ReceiptTotals(_Input):
    receipt_rows: list[ReceiptAmount] = Field(
        min_length=1,
        max_length=50,
        description="Exact decimal amounts and ISO currencies with evidence quotes and references from messages or attachments read this turn.",
    )


class _SaveMemory(_Input):
    domain_tag: str = Field(min_length=1, max_length=32)
    fact_markdown: str = Field(default="", max_length=2048)
    receipt_rows: list[ReceiptAmount] | None = Field(
        default=None,
        min_length=1,
        max_length=50,
        description="For receipt totals, pass model-extracted exact decimal amounts and ISO currencies, with source_ref equal to a message or attachment actually read this turn. Leave fact_markdown empty: this tool computes Decimal totals and prepares the summary in the same call. Do not turn missing or unread evidence into zero.",
    )


class _Empty(_Input):
    pass
