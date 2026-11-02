"""Current memory projection and evidence-bound receipt arithmetic tools."""

from .accounting import ReceiptAmount, sum_receipt_amounts, validate_receipt_amount_evidence
from .protocol import _await


class EmailMemoryTools:
    def __init__(self, state):
        self.state = state

    async def memory_call(self, name, **arguments):
        await self.state.context.require_access()
        if self.state.runtime.memory_port is None:
            return {"status": "unavailable", "saved": False}
        async with self.state.review_lock:
            if name == "save_to_memory_md" and self.state.directives:
                return {
                    "status": "pending_client_commit",
                    "saved": False,
                    "code": "another_review_pending",
                }
            result = await _await(getattr(self.state.runtime.memory_port, name)(**arguments))
            if isinstance(result, dict) and isinstance(result.get("directive"), dict):
                self.state.directives.append(result["directive"])
        await self.state.context.require_access()
        if isinstance(result, dict):
            if name == "save_to_memory_md" and result.get("saved") is True:
                self.state.effects.append({"tool": name})
        return result

    async def read_memory_md(self, section_or_query: str = ""):
        return await self.memory_call("read_memory_md", section_or_query=section_or_query)

    async def save_to_memory_md(
        self,
        domain_tag: str,
        fact_markdown: str = "",
        receipt_rows: list[ReceiptAmount] | None = None,
    ):
        totals = None
        if receipt_rows:
            receipt_rows = [ReceiptAmount.model_validate(row) for row in receipt_rows]
            if fact_markdown or any(
                (
                    not validate_receipt_amount_evidence(
                        row, self.state.read_sources.get(row.source_ref, "")
                    )
                    for row in receipt_rows
                )
            ):
                return {
                    "status": "input_required",
                    "saved": False,
                    "code": "receipt_sources_or_summary_invalid",
                    "message": "Use sources read this turn with an exact evidence_quote containing the amount, and leave fact_markdown empty for the computed receipt summary. Read a PDF/CSV when its amount is absent from the body.",
                }
            totals = sum_receipt_amounts(receipt_rows)
            lines = ["Receipt amounts from retrieved readable evidence; coverage may be partial:"]
            lines.extend((f"- {row.label}: {row.currency} {row.amount}" for row in receipt_rows))
            lines.extend(
                (
                    f"- Total {currency}: {amount}"
                    for currency, amount in totals["currency_totals"].items()
                )
            )
            fact_markdown, domain_tag = ("\n".join(lines), "finance")
        result = await self.memory_call(
            "save_to_memory_md", domain_tag=domain_tag, fact_markdown=fact_markdown
        )
        return {**result, **(totals or {})}
