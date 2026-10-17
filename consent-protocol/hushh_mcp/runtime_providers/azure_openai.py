"""The person's own Azure OpenAI deployment as their agent's model (mode ``user_azure_mi``).

Topology, never behaviour. The hub renders ``AZURE_OPENAI_ENDPOINT`` and
``AZURE_OPENAI_DEPLOYMENT`` into an Azure pod, exactly as listed in
``docs/reference/architecture/byoc-azure.md`` ("Agent environment contract"). The pod
reaches that deployment as its OWN user-assigned identity: no key exists anywhere, the
bill is the person's, and nothing in this module may fall back to a Hussh-managed
identity. A topology that is half rendered or malformed refuses; it never guesses.

``azure_openai`` and ``user_azure_mi`` are a pair. The provider is not in the general
registry on purpose: it is selected by the mode alone, never by name from a picker, and
an Azure default is not "proven" until it passes the same evals as Gemini.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

AZURE_OPENAI_PROVIDER = "azure_openai"
USER_AZURE_MI_MODE = "user_azure_mi"
#: The resource whose token Azure OpenAI accepts for an Entra (managed identity) caller.
AZURE_OPENAI_AUDIENCE = "https://cognitiveservices.azure.com"
AZURE_OPENAI_ENDPOINT_ENV = "AZURE_OPENAI_ENDPOINT"
AZURE_OPENAI_DEPLOYMENT_ENV = "AZURE_OPENAI_DEPLOYMENT"

# Cognitive Services custom subdomain: letters, digits and hyphens, alphanumeric at both
# ends. Only the commercial-cloud OpenAI host is accepted, because the pod's own bearer
# token travels to whatever host this names.
_RESOURCE_HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.openai\.azure\.com$")
_DEPLOYMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_PROBE_TIMEOUT_SECONDS = 20
_DETAIL_MAX = 160

TokenProvider = Callable[[], str]
ModelProbe = Callable[..., dict[str, Any]]


class AzureOpenAITopologyInvalid(RuntimeError):
    """The rendered Azure model topology is incomplete or malformed."""


class AzureOpenAIModeMismatch(ValueError):
    """``azure_openai`` was asked for outside ``user_azure_mi``, or the reverse."""


class AzureOpenAICredentialUnavailable(RuntimeError):
    """This image cannot mint the pod's own workload token."""


@dataclass(frozen=True)
class AzureOpenAITopology:
    """Where the person's deployment lives. Endpoint metadata only, never a credential."""

    endpoint: str
    deployment: str

    @property
    def host(self) -> str:
        return str(urlsplit(self.endpoint).hostname or "")

    @property
    def base_url(self) -> str:
        """The Azure OpenAI v1 API root, which speaks the OpenAI wire format."""
        return f"{self.endpoint}openai/v1/"


def _clean(env: Mapping[str, str], name: str) -> str:
    return str(env.get(name) or "").strip()


def _endpoint(raw: str) -> str:
    refusal = AzureOpenAITopologyInvalid(
        f"{AZURE_OPENAI_ENDPOINT_ENV} must be https://<resource>.openai.azure.com/"
    )
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        raise refusal from None
    host = str(parts.hostname or "").lower()
    if (
        parts.scheme != "https"
        or not _RESOURCE_HOST_RE.fullmatch(host)
        or port is not None
        or parts.username
        or parts.password
        or parts.path not in {"", "/"}
        or parts.query
        or parts.fragment
    ):
        raise refusal
    return f"https://{host}/"


def valid_deployment_name(name: str) -> bool:
    return bool(_DEPLOYMENT_RE.fullmatch(str(name or "")))


def azure_openai_configured(environ: Mapping[str, str] | None = None) -> bool:
    """Whether this process carries ANY Azure model topology, complete or not."""
    env = os.environ if environ is None else environ
    return bool(_clean(env, AZURE_OPENAI_ENDPOINT_ENV) or _clean(env, AZURE_OPENAI_DEPLOYMENT_ENV))


def azure_openai_topology(environ: Mapping[str, str] | None = None) -> AzureOpenAITopology | None:
    """The rendered topology, None when absent, and a refusal when half rendered."""
    env = os.environ if environ is None else environ
    endpoint = _clean(env, AZURE_OPENAI_ENDPOINT_ENV)
    deployment = _clean(env, AZURE_OPENAI_DEPLOYMENT_ENV)
    if not endpoint and not deployment:
        return None
    if not endpoint or not deployment:
        raise AzureOpenAITopologyInvalid(
            f"Azure model topology is incomplete: {AZURE_OPENAI_ENDPOINT_ENV} and "
            f"{AZURE_OPENAI_DEPLOYMENT_ENV} are rendered together"
        )
    if not valid_deployment_name(deployment):
        raise AzureOpenAITopologyInvalid(f"{AZURE_OPENAI_DEPLOYMENT_ENV} is not a deployment name")
    return AzureOpenAITopology(endpoint=_endpoint(endpoint), deployment=deployment)


def owner_azure_model() -> tuple[str, str] | None:
    """(provider, deployment) of this pod's own Azure model, or None when it has none."""
    topology = azure_openai_topology()
    if topology is None:
        return None
    return AZURE_OPENAI_PROVIDER, topology.deployment


def workload_token_provider() -> TokenProvider:
    """The pod's own workload token for Azure OpenAI, minted per call.

    Imported lazily: ``pod_workload_identity`` owns the managed identity endpoint and
    its caching, and an image without it must still import this module.
    """

    def token() -> str:
        try:
            from hushh_mcp.services.pod_workload_identity import (  # noqa: PLC0415
                get_workload_token,
            )
        except ImportError as exc:
            raise AzureOpenAICredentialUnavailable(
                "this image carries no pod workload identity"
            ) from exc
        minted = get_workload_token(AZURE_OPENAI_AUDIENCE)
        if not isinstance(minted, str) or not minted:
            raise AzureOpenAICredentialUnavailable("the pod workload identity minted no token")
        return minted

    return token


def require_owner_azure_pair(
    *, runtime_provider: str, runtime_mode: str, credential: str | None = None
) -> None:
    """Admit exactly ``azure_openai`` in ``user_azure_mi`` with no key; refuse all else.

    Every Azure door calls this, so a caller that reaches one with any other pair
    (including two non-Azure values, or the two swapped) is refused, never served.
    """
    is_azure_provider = str(runtime_provider or "").strip().lower() == AZURE_OPENAI_PROVIDER
    is_azure_mode = str(runtime_mode or "").strip() == USER_AZURE_MI_MODE
    if not (is_azure_provider and is_azure_mode):
        raise AzureOpenAIModeMismatch(
            f"{AZURE_OPENAI_PROVIDER} is served only in mode {USER_AZURE_MI_MODE}, "
            "and that mode serves only that provider"
        )
    if str(credential or "").strip():
        raise AzureOpenAIModeMismatch(
            "the pod's own Azure identity cannot be constructed from an API key"
        )


def build_owner_azure_transport(
    *,
    runtime_provider: str,
    runtime_mode: str,
    credential: str | None = None,
    topology: AzureOpenAITopology | None = None,
    token_provider: TokenProvider | None = None,
    http_client: Any = None,
) -> Any:
    """The Responses API transport for the person's deployment, as the pod's own identity.

    Responses, not Chat Completions: GPT-6 and GPT-5.6 deployments refuse tools with
    reasoning on Chat Completions (``openai_responses_transport``). The Responses API
    sends no sampling controls, so a reasoning deployment never sees a temperature
    it refuses.
    """
    require_owner_azure_pair(
        runtime_provider=runtime_provider, runtime_mode=runtime_mode, credential=credential
    )
    resolved = topology if topology is not None else azure_openai_topology()
    if resolved is None:
        raise AzureOpenAITopologyInvalid("this pod carries no Azure model topology")
    from .openai_responses_transport import OpenAIResponsesTransport  # noqa: PLC0415

    return OpenAIResponsesTransport(
        base_url=resolved.base_url,
        provider=AZURE_OPENAI_PROVIDER,
        token_provider=token_provider or workload_token_provider(),
        http_client=http_client,
    )


def owner_azure_client(
    runtime_provider: str, runtime_mode: str, credential: str | None = None
) -> Any:
    """The only door to ``azure_openai`` for a turn's model client.

    The provider is unknown to the general registry, so the key and managed builders
    in ``factory`` refuse it; this door serves it only in ``user_azure_mi``, as the
    pod's own identity, and ``credential`` exists only to be refused.
    """
    return build_owner_azure_transport(
        runtime_provider=runtime_provider, runtime_mode=runtime_mode, credential=credential
    )


def build_owner_azure_adk_model(
    deployment: str, *, mode: str, provider: str, api_key: str | None
) -> Any:
    """One's head on the person's deployment. The deployment name IS the model.

    ``api_key`` exists only to be refused: the pod's own identity is the credential.
    Callers dispatch here BEFORE any Gemini alias rewrite, because ``default`` is a
    legal deployment name that the rewrite would turn into a Gemini model id.
    """
    require_owner_azure_pair(runtime_provider=provider, runtime_mode=mode, credential=api_key)
    deployment = str(deployment or "").strip()
    if not valid_deployment_name(deployment):
        raise AzureOpenAIModeMismatch("the Azure OpenAI deployment name is invalid")
    from .adk_model import ProviderAdkModel  # noqa: PLC0415

    return ProviderAdkModel(
        model=deployment,
        provider=AZURE_OPENAI_PROVIDER,
        credential="",
        runtime_mode=USER_AZURE_MI_MODE,
    )


def _error_fields(response: Any) -> tuple[str, str]:
    try:
        body = response.json() or {}
    except Exception:  # noqa: BLE001 - a probe reports, never raises
        body = {}
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return "", ""
    return str(error.get("code") or "")[:64], str(error.get("message") or "")[:_DETAIL_MAX]


def probe_outcome(status: int, code: str = "") -> str:
    """What one minimal request as the pod's identity says about the deployment.

    Azure OpenAI answers a missing data-plane role with 403, or with 401 and the error
    code ``PermissionDenied``; any other 401 is a token the service did not accept.
    """
    if status == 200:
        return "reachable"
    if status == 404:
        return "not_deployed"
    if status == 403 or (status == 401 and code == "PermissionDenied"):
        return "role_missing"
    if status == 401:
        return "identity_rejected"
    if status == 429:
        return "quota_exhausted"
    if status == 400:
        return "request_refused"
    return "unavailable"


def probe_azure_openai_deployment(
    deployment: str,
    *,
    topology: AzureOpenAITopology | None = None,
    session: Any = None,
    token: str | None = None,
) -> dict[str, Any]:
    """Can THIS pod, as itself, reach ``deployment`` on the person's own resource?

    One bounded chat request with a tiny output cap. ``reachable`` is true only for a
    200; ``outcome`` names why it is not. The endpoint is always the rendered one, so a
    caller can name a deployment but never a host for the pod's token to travel to.
    """
    report: dict[str, Any] = {"provider": AZURE_OPENAI_PROVIDER, "model": deployment}
    try:
        resolved = topology if topology is not None else azure_openai_topology()
    except AzureOpenAITopologyInvalid as exc:
        return {**report, "reachable": None, "outcome": "topology_invalid", "detail": str(exc)}
    if resolved is None:
        return {**report, "reachable": None, "outcome": "topology_missing", "detail": ""}
    report["endpoint"] = resolved.host
    if token is None:
        try:
            token = workload_token_provider()()
        except Exception as exc:  # noqa: BLE001 - a probe reports, never raises
            return {
                **report,
                "reachable": None,
                "outcome": "identity_unavailable",
                "detail": type(exc).__name__,
            }
    return _post_probe(report, resolved, deployment, token=token, session=session)


def model_probe(vertex_probe: ModelProbe) -> ModelProbe:
    """The reachability probe this pod's own model topology calls for.

    Any rendered Azure value, complete or not, selects the Azure probe, so a
    half-rendered pod reports ``topology_invalid`` and never asks Vertex. ``model``
    then names a deployment on the RENDERED resource only, and ``location`` has no
    Azure meaning.
    """
    if not azure_openai_configured():
        return vertex_probe

    def azure_probe(model: str, *, location: str = "") -> dict[str, Any]:
        del location
        return probe_azure_openai_deployment(model)

    return azure_probe


def _post_probe(
    report: dict[str, Any],
    topology: AzureOpenAITopology,
    deployment: str,
    *,
    token: str,
    session: Any,
) -> dict[str, Any]:
    import requests  # type: ignore[import-untyped]  # noqa: PLC0415

    http = session if session is not None else requests.Session()
    try:
        response = http.post(
            f"{topology.base_url}chat/completions",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "model": deployment,
                "messages": [{"role": "user", "content": "ping"}],
                "max_completion_tokens": 16,
            },
            timeout=_PROBE_TIMEOUT_SECONDS,
        )
    except Exception as exc:  # noqa: BLE001 - a probe reports, never raises
        return {**report, "reachable": None, "outcome": "unavailable", "detail": type(exc).__name__}
    finally:
        if session is None:
            http.close()
    status = int(getattr(response, "status_code", 0) or 0)
    code, message = _error_fields(response)
    return {
        **report,
        "status": status,
        "reachable": status == 200,
        "outcome": probe_outcome(status, code),
        "detail": message or code,
    }
