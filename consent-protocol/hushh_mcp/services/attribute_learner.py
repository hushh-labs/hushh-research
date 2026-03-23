# consent-protocol/hushh_mcp/services/attribute_learner.py
"""
Attribute Learner - Extracts user attributes from conversation and auto-classifies into domains.

This service uses LLM to analyze conversations and extract structured user preferences,
then stores them in the PKM with appropriate domain classification.
"""

import json
import logging
import os
from dataclasses import dataclass
from typing import Optional

from google import genai
from google.genai import types as genai_types

from hushh_mcp.constants import GEMINI_MODEL

logger = logging.getLogger(__name__)


@dataclass
class ExtractedAttribute:
    """An attribute extracted from conversation."""

    domain: str
    key: str
    value: str
    confidence: float = 0.8


EXTRACTION_PROMPT = """You are an attribute extraction system. Analyze the conversation and extract any user preferences, facts, or characteristics that were explicitly stated.

IMPORTANT RULES:
1. Only extract EXPLICIT statements, not assumptions or implications
2. Each attribute must have a clear domain, key, and value
3. Use lowercase snake_case for keys (e.g., "risk_tolerance", "favorite_cuisine")
4. Domains should be one of: financial, food, health, travel, professional, entertainment, shopping, subscriptions, or a new relevant domain
5. Return empty array if no clear attributes can be extracted

User message: {user_message}
Assistant response: {assistant_response}

Return a JSON object with this exact structure:
{{
    "attributes": [
        {{"domain": "financial", "key": "risk_tolerance", "value": "aggressive", "confidence": 0.9}},
        {{"domain": "food", "key": "dietary_restriction", "value": "vegetarian", "confidence": 0.95}}
    ]
}}

Only include attributes that were clearly stated. If nothing was stated, return {{"attributes": []}}.
"""


class AttributeLearner:
    """
    Extracts user attributes from conversation and auto-classifies into domains.

    Uses Google Gemini to analyze conversation and extract structured data,
    then stores it in the PKM for future context.
    """

    def __init__(self):
        self._client = None
        self._pkm_service = None

    @property
    def client(self):
        """Get the google.genai client (from google-adk)."""
        if not hasattr(self, "_client") or self._client is None:
            api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
            if api_key:
                self._client = genai.Client(api_key=api_key)
            else:
                self._client = None
        return self._client

    @property
    def pkm_service(self):
        if self._pkm_service is None:
            from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service

            self._pkm_service = get_pkm_service()
        return self._pkm_service

    async def extract_attributes(
        self,
        user_message: str,
        assistant_response: str,
    ) -> list[ExtractedAttribute]:
        """
        Extract structured attributes from a conversation turn.

        Args:
            user_message: The user's message
            assistant_response: Kai's response

        Returns:
            List of extracted attributes
        """
        if not self.client:
            return []

        try:
            prompt = EXTRACTION_PROMPT.format(
                user_message=user_message,
                assistant_response=assistant_response,
            )

            config = genai_types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.1,  # Low temperature for consistent extraction
            )

            response = await self.client.aio.models.generate_content(
                model=GEMINI_MODEL,
                contents=prompt,
                config=config,
            )

            # Parse JSON response
            result = json.loads(response.text)
            attributes = []

            for attr in result.get("attributes", []):
                if all(k in attr for k in ["domain", "key", "value"]):
                    attributes.append(
                        ExtractedAttribute(
                            domain=attr["domain"].lower().strip(),
                            key=attr["key"].lower().strip().replace(" ", "_"),
                            value=str(attr["value"]),
                            confidence=float(attr.get("confidence", 0.8)),
                        )
                    )

            return attributes

        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse attribute extraction response: {e}")
            return []
        except Exception as e:
            logger.error(f"Error extracting attributes: {e}")
            return []

    async def extract_and_store(
        self,
        user_id: str,
        user_message: str,
        assistant_response: str,
    ) -> list[dict]:
        """
        Extract attributes from conversation and record them as mutation events.

        Learned attributes are no longer written into the legacy summary index tables.
        Sensitive semantic state belongs in the BYOK-encrypted domain payloads, not the
        discovery index. We still emit structured mutation events so the research flow
        remains auditable and replayable.

        Args:
            user_id: The user's ID
            user_message: The user's message
            assistant_response: Kai's response

        Returns:
            List of stored attributes as dicts
        """
        # Extract attributes
        attributes = await self.extract_attributes(user_message, assistant_response)

        if not attributes:
            return []

        stored = []
        domain_attrs: dict[str, dict] = {}
        for attr in attributes:
            domain_attrs.setdefault(attr.domain, {})[attr.key] = attr.value

        for domain, inferred_payload in domain_attrs.items():
            try:
                success = await self.pkm_service.record_mutation_event(
                    user_id=user_id,
                    domain=domain,
                    operation_type="attribute_inference",
                    path_set=sorted(inferred_payload.keys()),
                    source_agent="attribute_learner",
                    confidence=max(
                        (attr.confidence for attr in attributes if attr.domain == domain),
                        default=0.8,
                    ),
                    metadata={"attributes": inferred_payload},
                )
                if success:
                    for key, value in inferred_payload.items():
                        stored.append(
                            {
                                "domain": domain,
                                "key": key,
                                "value": value,
                                "scope": f"attr.{domain}.{key}",
                            }
                        )
                        logger.info(
                            f"Recorded learned attribute inference: {domain}.{key} for user {user_id}"
                        )
            except Exception as e:
                logger.error(f"Error storing inferred attribute event for {domain}: {e}")

        return stored


# Singleton instance
_attribute_learner: Optional[AttributeLearner] = None


def get_attribute_learner() -> AttributeLearner:
    """Get singleton AttributeLearner instance."""
    global _attribute_learner
    if _attribute_learner is None:
        _attribute_learner = AttributeLearner()
    return _attribute_learner
