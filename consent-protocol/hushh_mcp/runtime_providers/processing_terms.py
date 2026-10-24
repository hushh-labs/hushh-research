"""Deterministic admission for One's protected-information model processing.

Synthetic credential probes remain in the generic factory. Passing one is not
proof of the account terms required to process connected-service information.
"""

from .registry import is_known_provider, normalize_provider


class ProcessingTermsUnverifiedError(ValueError):
    """A selected Gemini key has no verified terms for protected processing."""

    code = "AGENT_RUNTIME_PROVIDER_TERMS_UNVERIFIED"

    def __init__(self) -> None:
        super().__init__(
            "One requires verified Google Cloud processing; unverified Gemini keys are unavailable"
        )


def require_verified_gemini_processing(provider: str, runtime_mode: str | None) -> None:
    """Admit One inference independently of a successful synthetic key probe.

    History, Memory and command context can contain Workspace-derived information.
    Both arbitrary key transports lack proof of their account's processing terms.
    Reject the selected target; never substitute a managed identity.
    """
    canonical = normalize_provider(provider) if is_known_provider(provider) else provider
    if canonical != "gemini":
        return
    if runtime_mode in {None, "byok"}:
        raise ProcessingTermsUnverifiedError()
    if runtime_mode in {"hushh_managed_vertex", "user_adc"}:
        from hushh_mcp.runtime_settings import managed_ai_settings

        if managed_ai_settings().auth_mode != "vertex_adc":
            raise ProcessingTermsUnverifiedError()


def one_runtime_mode_refusal(mode: str) -> dict[str, str]:
    """Public One credential-policy refusal, without credentials or provider text."""
    if mode == "byok":
        refusal = ProcessingTermsUnverifiedError()
        return {"error_code": refusal.code, "message": str(refusal)}
    return {
        "error_code": "AGENT_RUNTIME_MODE_INVALID",
        "message": "Agent runtime credential mode is invalid.",
    }
