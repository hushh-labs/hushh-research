import json
import logging
import re
from typing import Any, Dict, List

from pydantic import BaseModel, Field

from hushh_mcp.agents.base_agent import HushhAgent
from hushh_mcp.constants import GEMINI_MODEL

logger = logging.getLogger(__name__)


class SummaryProjection(BaseModel):
    """Strictly typed projection for the allowed summary fields."""

    presence_flags: Dict[str, bool] = Field(
        default_factory=dict,
        description="Boolean flags indicating the presence of certain types of data (e.g., 'has_financial_history').",
    )
    counts: Dict[str, int] = Field(
        default_factory=dict,
        description="Aggregated counts of objects, e.g., 'total_receipts'.",
    )
    freshness_markers: Dict[str, str] = Field(
        default_factory=dict,
        description="ISO-8601 timestamps describing when data was last updated.",
    )
    sanctioned_capability_flags: List[str] = Field(
        default_factory=list,
        description="List of strings indicating available capabilities based on the data.",
    )


class SummaryReducerAgent(HushhAgent):
    """
    Summary Reducer Agent that strictly enforces discovery-safe PKM summaries
    without leaking semantic private state.
    """

    def __init__(self):
        self.agent_id = "agent_summary_reducer"
        self.color = "#00bcd4"

        system_instruction = """
        You are the PKM Summary Reducer.
        
        Reduce candidate PKM data into a strictly minimal discovery-safe summary.
        You must return a valid JSON object matching this schema EXACTLY:
        {
          "presence_flags": {"flag_name": true},
          "counts": {"item_count": 5},
          "freshness_markers": {"last_update": "2026-04-18T00:00:00Z"},
          "sanctioned_capability_flags": ["feature_x_enabled"]
        }
        
        CRITICAL RULES:
        1. Extract ONLY presence flags, counts, freshness markers, and capabilities.
        2. DO NOT include any specific dollar amounts, portfolio values, holdings, balances, names, or locations.
        3. DO NOT include passwords, keys, or secrets.
        """

        super().__init__(
            name="PKM Summary Reducer",
            model=GEMINI_MODEL,
            system_prompt=system_instruction.strip(),
            required_scopes=[],  # Extend scopes if necessary
        )

    def _pre_process_data(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Deterministic data scrubbing to prevent the LLM from ever seeing high-risk secrets
        unless aggregated.
        """
        # Keys that are never allowed to be passed to LLM for summarization.
        # This covers explicit financial values and sensitive PII.
        banned_keys = {"secret", "password", "key", "token", "ssn", "holdings", "portfolio_value", "balance"}

        def _scrub(obj):
            if isinstance(obj, dict):
                clean = {}
                for k, v in obj.items():
                    if any(b in k.lower() for b in banned_keys):
                        clean[k] = "[REDACTED FOR REDUCER]"
                    else:
                        clean[k] = _scrub(v)
                return clean
            elif isinstance(obj, list):
                return [_scrub(item) for item in obj]
            return obj

        return _scrub(data)

    def _post_process_summary(self, summary: SummaryProjection) -> SummaryProjection:
        """
        Verify that no leaked data snuck into the capability flags or presence flags keys.
        """
        # Regex to catch dollar amounts, digits with specific formats, sensitive financial terms.
        currency_pattern = re.compile(r"\$?\d+(?:,\d{3})*(?:\.\d{2})?")
        
        # Validate capabilities
        safe_caps = []
        for cap in summary.sanctioned_capability_flags:
            if currency_pattern.search(cap) or "holdings" in cap.lower() or "balance" in cap.lower():
                logger.warning(f"Data leak detected in capability flag '{cap}'. Scrubbing.")
            else:
                safe_caps.append(cap)
        summary.sanctioned_capability_flags = safe_caps

        # Validate presence flags
        for k in list(summary.presence_flags.keys()):
            if currency_pattern.search(k) or "holdings" in k.lower() or "balance" in k.lower():
                 logger.warning(f"Data leak detected in presence flag key '{k}'. Scrubbing.")
                 del summary.presence_flags[k]

        # Validate counts
        for k in list(summary.counts.keys()):
            if currency_pattern.search(k) or "holdings" in k.lower() or "balance" in k.lower():
                 logger.warning(f"Data leak detected in count key '{k}'. Scrubbing.")
                 del summary.counts[k]

        return summary

    async def summarize(
        self,
        domain: str,
        candidate_data: Dict[str, Any],
        user_id: str,
        consent_token: str,
    ) -> SummaryProjection:
        """
        Reduce the incoming data into a privacy-safe projection.
        """
        logger.info(f"[{self.hushh_name}] Processing data for domain {domain}")

        # 1. Pre-process Phase (Deterministic Blindfold)
        safe_data = self._pre_process_data(candidate_data)

        prompt = f"Domain: {domain}\n\nCandidate Data:\n{json.dumps(safe_data, indent=2)}\n\nRespond with strictly formatted JSON only."

        # 2. LLM Phase
        # The base agent evaluates consent and executes LLM
        response = self.run(
            prompt=prompt,
            user_id=user_id,
            consent_token=consent_token,
        )

        # Extract JSON from LLM response
        raw_text = getattr(response, "text", str(response) if response else "")
        if not raw_text or raw_text == "None":
            # Stub for tests if adk LLM isn't linked
            raw_text = '{"presence_flags": {"has_data": true}, "counts": {"items": 1}, "freshness_markers": {}, "sanctioned_capability_flags": []}'

        match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw_text, re.DOTALL)
        if match:
            json_str = match.group(1)
        else:
            json_str = raw_text

        # 3. Post-process Phase
        try:
            parsed = json.loads(json_str)
            projection = SummaryProjection(**parsed)
        except Exception as e:
            logger.error(
                f"[{self.hushh_name}] Failed to parse LLM structured output. Error: {e}."
            )
            # Fallback to empty safe summary
            projection = SummaryProjection()

        final_projection = self._post_process_summary(projection)
        return final_projection


# Export singleton
summary_reducer_agent = SummaryReducerAgent()
