# hushh_mcp/operons/kai/providers/registry.py
"""
Provider registry and consent-gated dispatcher.

This is the integration seam: Kai operons call `dispatch(...)` instead
of hitting Gemini directly. The dispatcher:

1. Validates the consent token presented by the caller using the
   existing `validate_token()` helper from `hushh_mcp.consent.token`
   (sync, signature + revocation check).
2. Checks that the token's scope authorizes the chosen provider via
   `scopes.token_authorizes()`. If not, raises `ConsentScopeViolation`
   BEFORE any provider method is called -- guaranteeing zero network
   I/O on a denied request.
3. Records latency + outcome to `consent_audit` (hashes only).
4. Returns the provider's `CompletionResponse` unchanged.

YAML-driven configuration lives at `config/kai_inference_providers.yaml`.
The default provider is `gemini`, preserving existing behavior on every
call site that hasn't been migrated yet.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Optional

import yaml  # PyYAML is already in deps via google-adk

from hushh_mcp.consent.token import validate_token

from .audit import TimedDispatch, get_audit_writer
from .base import CompletionRequest, CompletionResponse, LLMProvider
from .errors import ConsentScopeViolation, ProviderError, ProviderUnavailable
from .scopes import scope_for_provider, token_authorizes

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_REGISTRY: dict[str, LLMProvider] = {}
_DEFAULT_PROVIDER: str = "gemini"
_LOADED: bool = False


def register(provider: LLMProvider) -> None:
    """Register a provider instance under its `name`."""
    if not provider.name:
        raise ValueError(f"Provider {provider.__class__.__name__} has no `name`")
    _REGISTRY[provider.name] = provider
    logger.info("[kai-providers] registered provider name=%s kind=%s", provider.name, provider.kind)


def get_provider(name: str) -> LLMProvider:
    """Look up a registered provider by name."""
    _ensure_loaded()
    if name not in _REGISTRY:
        available = ", ".join(sorted(_REGISTRY)) or "<none>"
        raise ProviderUnavailable(
            f"No provider named {name!r} is registered. Available: {available}",
            provider=name,
        )
    return _REGISTRY[name]


def available_providers() -> list[str]:
    """Names of all registered providers, in insertion order."""
    _ensure_loaded()
    return list(_REGISTRY)


def default_provider_name() -> str:
    _ensure_loaded()
    return _DEFAULT_PROVIDER


# ---------------------------------------------------------------------------
# Configuration loader
# ---------------------------------------------------------------------------


def _config_path() -> Path:
    """
    Resolve the providers YAML path.

    Looks at $KAI_PROVIDERS_CONFIG first, then falls back to
    config/kai_inference_providers.yaml at the repo root.
    """
    raw = os.getenv("KAI_PROVIDERS_CONFIG")
    if raw:
        return Path(raw).expanduser()
    # Repo root resolution: this file lives at
    # consent-protocol/hushh_mcp/operons/kai/providers/registry.py
    # config lives at consent-protocol/config/kai_inference_providers.yaml
    here = Path(__file__).resolve()
    repo_root = here.parents[4]  # providers -> kai -> operons -> hushh_mcp -> consent-protocol
    return repo_root / "config" / "kai_inference_providers.yaml"


def load_registry(path: Optional[Path] = None) -> None:
    """
    Load providers from YAML. Idempotent.

    The YAML schema is::

        default: gemini
        providers:
          gemini:
            class: hushh_mcp.operons.kai.providers.gemini:GeminiProvider
            model: gemini-3-flash-preview
          openai:
            class: hushh_mcp.operons.kai.providers.openai:OpenAIProvider
            model: gpt-4o-mini
            base_url: https://api.openai.com/v1
          ...

    Providers are constructed eagerly but readiness is checked lazily
    at dispatch time -- a missing API key does not crash startup.
    """
    global _DEFAULT_PROVIDER, _LOADED

    cfg_path = path or _config_path()
    if not cfg_path.exists():
        logger.warning(
            "[kai-providers] config not found at %s; falling back to gemini-only registry",
            cfg_path,
        )
        _register_builtin_gemini_only()
        _LOADED = True
        return

    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    _DEFAULT_PROVIDER = str(raw.get("default") or "gemini")

    for name, spec in (raw.get("providers") or {}).items():
        try:
            provider = _instantiate_provider(name, spec)
        except Exception as exc:  # noqa: BLE001 - registry loader must not crash boot
            logger.warning(
                "[kai-providers] failed to instantiate provider %s: %s", name, exc
            )
            continue
        register(provider)

    if not _REGISTRY:
        logger.warning(
            "[kai-providers] no providers loaded from config; falling back to gemini-only"
        )
        _register_builtin_gemini_only()

    _LOADED = True


def _ensure_loaded() -> None:
    if not _LOADED:
        load_registry()


def _register_builtin_gemini_only() -> None:
    """Fallback when no config is present: keep current Gemini-only behavior."""
    try:
        from .gemini import GeminiProvider

        register(GeminiProvider())
    except Exception as exc:  # noqa: BLE001 - import-time errors get logged, not raised
        logger.warning("[kai-providers] could not register fallback Gemini provider: %s", exc)


def _instantiate_provider(name: str, spec: dict[str, Any]) -> LLMProvider:
    cls_path = spec.get("class")
    if not cls_path or ":" not in cls_path:
        raise ValueError(
            f"Provider {name}: 'class' must be 'module.path:ClassName' (got {cls_path!r})"
        )
    module_path, cls_name = cls_path.split(":", 1)
    import importlib

    module = importlib.import_module(module_path)
    cls = getattr(module, cls_name)
    kwargs = {k: v for k, v in spec.items() if k != "class"}
    instance = cls(**kwargs)
    if not isinstance(instance, LLMProvider):
        raise TypeError(f"Provider {name}: {cls_path} is not an LLMProvider")
    if instance.name != name:
        # Allow YAML to override the in-class default name without surprise.
        object.__setattr__(instance, "name", name)
    return instance


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


async def dispatch(
    request: CompletionRequest,
    *,
    consent_token: str,
    provider_name: Optional[str] = None,
    user_id: str = "",
    agent_id: str = "agent_kai",
) -> CompletionResponse:
    """
    Validate consent + dispatch to the chosen provider.

    Parameters
    ----------
    request:
        Canonical CompletionRequest. Operons translate Kai prompts into
        this shape; the existing Gemini operon still works because the
        GeminiProvider mirrors `_generate_content_text(prompt=...)`.
    consent_token:
        The token presented by the caller. MUST authorize the provider's
        scope (e.g. `agent.kai.inference.cloud.gemini`).
    provider_name:
        Provider key from the YAML registry. Defaults to the global default.
    user_id, agent_id:
        Audit context. Default agent_id matches `agent_kai` per
        `consent-protocol/hushh_mcp/constants.py`.

    Raises
    ------
    ConsentScopeViolation
        Token is invalid or its scope does not authorize the provider.
        Raised BEFORE any provider method is called.
    ProviderUnavailable
        Provider is not configured (missing creds, missing SDK).
    ProviderError
        Provider executed but returned an error.
    """
    chosen = provider_name or default_provider_name()
    required_scope = scope_for_provider(chosen)

    # 1. Validate token. validate_token checks signature, expiry, revocation
    #    AND (when expected_scope is provided) the token's own scope string.
    valid, reason, token = validate_token(consent_token, required_scope)
    if not valid or token is None:
        raise ConsentScopeViolation(
            f"Consent denied for inference provider {chosen!r}: {reason or 'unknown reason'}",
            provider=chosen,
            scope=required_scope,
        )

    # 2. Belt-and-braces authorization check using our hierarchy helpers.
    #    validate_token has already approved the scope string match, but if
    #    the token bears an umbrella scope (`agent.kai.inference.private`),
    #    upstream may reject before we get here. We re-check explicitly so
    #    the dispatch contract is documented in code, not implicit.
    #
    #    NOTE: for dynamic scopes (like ours), `token.scope` is a fallback
    #    enum value; the real scope string is in `token.scope_str`. Use
    #    that as the source of truth, falling back to the enum's value if
    #    scope_str is empty (legacy tokens).
    actual_scope = getattr(token, "scope_str", "") or (
        token.scope.value if hasattr(token.scope, "value") else str(token.scope)
    )
    if not token_authorizes(actual_scope, required_scope):
        # validate_token may have accepted exact-match scope; the umbrella
        # path is the additional surface this guard protects.
        raise ConsentScopeViolation(
            f"Token scope {actual_scope!r} does not authorize {required_scope!r}",
            provider=chosen,
            scope=required_scope,
        )

    provider = get_provider(chosen)
    ready, why_not = provider.is_ready()
    if not ready:
        raise ProviderUnavailable(
            f"Provider {chosen!r} not ready: {why_not or 'unknown'}",
            provider=chosen,
            scope=required_scope,
        )

    # 3. Audit + dispatch.
    token_id = getattr(token, "token_id", None) or getattr(token, "jti", None) or ""
    audit = get_audit_writer()
    with TimedDispatch(
        provider=chosen,
        scope=required_scope,
        model=provider.default_model,
        prompt=request.prompt,
    ) as timer:
        try:
            response = await provider.complete(request)
            timer.set_output(response.text, outcome="ok")
        except ProviderError:
            timer.set_outcome("error")
            raise
        except Exception as exc:  # noqa: BLE001
            timer.set_outcome("error", error_class=exc.__class__.__name__)
            raise ProviderError(
                f"Provider {chosen!r} raised {exc.__class__.__name__}: {exc}",
                provider=chosen,
                scope=required_scope,
            ) from exc

    try:
        await audit.write(
            token_id=token_id,
            user_id=user_id or getattr(token, "user_id", ""),
            agent_id=agent_id,
            record=timer.record,
        )
    except Exception as exc:  # noqa: BLE001 - audit failures NEVER block inference
        logger.warning("[kai-providers] audit write failed: %s", exc)

    return response
