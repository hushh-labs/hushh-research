# hushh_mcp/integrations/mlx/adapter.py
"""Consent gate for on-device MLX inference.

Design intent
-------------
This adapter is deliberately NOT an inference server and NOT an OpenAI-compatible
proxy. The MLX runtime for Apple Silicon lives (as a plan) in Swift under
``apps/one-mac/Sources/OneIndexer`` per ``docs/future/one-mac-knowledge-base-app.md``.
Shipping a parallel Python FastAPI inference daemon would create exactly the
duplicate authority the repo forbids.

What this module does provide is the missing Python-side piece: a strict consent
boundary that any local caller must pass before an inference callable executes.
It reuses the canonical Hushh Consent Token contract in
``hushh_mcp.consent.token`` (HMAC-SHA256 signed ``HCT:`` bearer tokens with
scope isolation, expiry, and revocation) instead of inventing a magic string.

Security posture
----------------
* Deny-by-default: no token, malformed token, wrong scope, expired token, or
  revoked token -> ``ConsentDenied``. The inference callable is never invoked.
* Scope isolation: the caller declares which ``ConsentScope`` the operation
  requires and the token is validated against exactly that scope via the
  canonical ``validate_token`` (which uses ``scope_matches`` for domain
  isolation). There is no fallback that accepts unsigned/forged tokens.
* No plaintext prompt logging: only the deny/allow decision and reason are
  logged, matching the zero-knowledge posture.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable, Optional, Union, cast

from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.types import HushhConsentToken

logger = logging.getLogger(__name__)

# Reasonable default scope for a local reasoning/inference call. Callers can
# override per operation. AGENT_KAI_INFER is the closest existing static scope
# for local model inference; embedding work should pass EMBEDDING_PROFILE_COMPUTE.
DEFAULT_INFERENCE_SCOPE = ConsentScope.AGENT_KAI_INFER

# Inference callable signature: (prompt, token) -> str.
InferenceFn = Callable[[str, HushhConsentToken], str]


class ConsentDenied(Exception):
    """Raised when the presented HCT fails validation. Carries a safe reason."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class MLXInferenceResult:
    """Result of a consented inference call."""

    output: str
    user_id: str
    agent_id: str
    scope: str
    commercial: bool
    runtime: str = "mlx-on-one"
    isolation_boundary: str = "zero-knowledge-local"
    metadata: dict = field(default_factory=dict)


class HCTGatedMLXAdapter:
    """Guards an injected MLX inference callable behind canonical HCT validation.

    The adapter never bundles a model. The real model runner (mlx-lm on Apple
    Silicon, or the Swift OneIndexer path) is injected as ``inference_fn`` so
    this consent boundary stays importable and testable on any platform,
    including CI on Linux/Windows where MLX cannot load.
    """

    def __init__(
        self,
        inference_fn: InferenceFn,
        *,
        required_scope: Union[str, ConsentScope] = DEFAULT_INFERENCE_SCOPE,
        require_commercial: Optional[bool] = None,
    ) -> None:
        if not callable(inference_fn):
            raise TypeError("inference_fn must be callable")
        self._inference_fn = inference_fn
        self._required_scope = required_scope
        self._require_commercial = require_commercial

    def authorize(self, consent_token: Optional[str]) -> HushhConsentToken:
        """Validate a token against the required scope. Deny-by-default.

        Returns the parsed ``HushhConsentToken`` on success; raises
        ``ConsentDenied`` on any failure. No forged-token fallback exists.
        """
        if not consent_token or not isinstance(consent_token, str):
            logger.info("mlx_adapter.consent_denied reason=missing_token")
            raise ConsentDenied("Missing consent token")

        valid, reason, token_obj = validate_token(
            consent_token,
            expected_scope=self._required_scope,
            require_commercial=self._require_commercial,
        )
        if not valid or token_obj is None:
            safe_reason = reason or "Invalid consent token"
            logger.info("mlx_adapter.consent_denied reason=%s", safe_reason)
            raise ConsentDenied(safe_reason)

        logger.info(
            "mlx_adapter.consent_granted agent_id=%s scope=%s commercial=%s",
            token_obj.agent_id,
            token_obj.scope_str,
            token_obj.commercial,
        )
        return cast(HushhConsentToken, token_obj)

    def run(self, prompt: str, consent_token: Optional[str]) -> MLXInferenceResult:
        """Authorize, then run the injected inference callable.

        The inference callable is invoked only after consent passes.
        """
        token_obj = self.authorize(consent_token)

        if not isinstance(prompt, str) or prompt == "":
            raise ValueError("prompt must be a non-empty string")

        output = self._inference_fn(prompt, token_obj)

        return MLXInferenceResult(
            output=output,
            user_id=str(token_obj.user_id),
            agent_id=str(token_obj.agent_id),
            scope=token_obj.scope_str,
            commercial=token_obj.commercial,
        )
