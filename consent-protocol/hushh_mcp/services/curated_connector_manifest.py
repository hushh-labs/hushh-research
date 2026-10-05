"""Checked-in manifests for curated (operator-registered) OAuth MCP connectors.

One JSON file per provider under `config/curated_connectors/` is the single
reviewed source for everything the application must not take from the
operator-writable registry table:

- the endpoint, authorize/token URL, scope and client-variable pins the OAuth
  adapter compares a live registry row against,
- the exact tool allowlist chat may offer,
- the exact tools that may run without a per-call review card,
- the per-environment redirect addresses the registry row is applied with.

Adding a provider is therefore "write one manifest, provision its client,
apply". The runtime is fail-closed: a provider with no manifest is never
served, a manifest that does not validate is never served, and the loader
never falls back to registry values.

Two client shapes are supported. `client_secret_post` providers (for example
HubSpot) have a client id and a client secret, both read from named
environment variables. `none` providers (public clients with PKCE, for example
Notion) have a client id only and pin the provider's dynamic-registration URL;
a manifest that names a secret variable for a public client, omits one for a
confidential client, or leaves a public registration endpoint unreviewed is
rejected.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from hushh_mcp.services.mcp_public_http import UnsafeMcpEndpoint, validate_mcp_endpoint

MANIFEST_VERSION = "curated-connector.v1"
MANIFEST_DIR = Path(__file__).resolve().parents[2] / "config" / "curated_connectors"
# A registration-only spec exists only to let an operator obtain an authenticated
# tools/list result for a public provider before a runtime manifest can safely
# name its tools. It is deliberately outside MANIFEST_DIR: it is not a catalog,
# registry, deploy, or runtime input.
REGISTRATION_SPEC_VERSION = "curated-connector-registration.v1"
REGISTRATION_SPEC_DIR = (
    Path(__file__).resolve().parents[2] / "config" / "curated_connector_registrations"
)

_CONNECTOR_ID = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
_RESERVED_PREFIXES = ("custom_", "google_")
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{1,127}$")
_TOOL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_TOKEN_AUTH_METHODS = ("client_secret_post", "none")
_ENVIRONMENTS = ("uat",)
_MAX_TOOLS = 200
_TOP_LEVEL_KEYS = frozenset(
    {
        "version",
        "connectorId",
        "displayName",
        "description",
        "mcpEndpoint",
        "oauth",
        "tools",
        "environments",
    }
)
_REGISTRATION_SPEC_TOP_LEVEL_KEYS = frozenset(
    {
        "version",
        "connectorId",
        "displayName",
        "description",
        "mcpEndpoint",
        "oauth",
        "environments",
    }
)
_OAUTH_KEYS = frozenset(
    {
        "authorizeUrl",
        "tokenUrl",
        "registrationUrl",
        "scopes",
        "tokenEndpointAuth",
        "clientIdEnv",
        "clientSecretEnv",
    }
)
_TOOLS_KEYS = frozenset({"allowlist", "freeRead"})


class CuratedConnectorManifestError(ValueError):
    pass


@dataclass(frozen=True)
class CuratedConnectorManifest:
    connector_id: str
    display_name: str
    description: str
    mcp_endpoint: str
    authorize_url: str
    token_url: str
    registration_url: str | None
    scopes: tuple[str, ...]
    token_endpoint_auth: str
    client_id_env: str
    client_secret_env: str | None
    tool_allowlist: tuple[str, ...]
    free_read_tools: frozenset[str]
    redirect_uris: dict[str, tuple[str, ...]]

    @property
    def is_public_client(self) -> bool:
        return self.token_endpoint_auth == "none"  # noqa: S105 - an auth method name, not a credential

    @property
    def secret_env_names(self) -> tuple[str, ...]:
        """Every environment variable this provider needs mounted, in order."""
        return tuple(name for name in (self.client_id_env, self.client_secret_env) if name)

    def pin(self) -> tuple[str, str, str, tuple[str, ...], str, str | None]:
        """The exact fields a live registry row must equal to be served."""
        return (
            self.mcp_endpoint,
            self.authorize_url,
            self.token_url,
            self.scopes,
            self.client_id_env,
            self.client_secret_env,
        )

    def to_descriptor(self, environment: str) -> dict[str, Any]:
        """An `external-mcp-connector.v1` descriptor for one environment."""
        if environment not in self.redirect_uris:
            raise CuratedConnectorManifestError(
                f"{self.connector_id} has no redirect addresses for environment {environment!r}."
            )
        descriptor: dict[str, Any] = {
            "version": "external-mcp-connector.v1",
            "connectorId": self.connector_id,
            "displayName": self.display_name,
            "description": self.description,
            "mcpEndpoint": self.mcp_endpoint,
            "authStyle": "oauth",
            "oauthAuthorizeUrl": self.authorize_url,
            "oauthTokenUrl": self.token_url,
            "oauthScopes": list(self.scopes),
            "oauthClientIdEnv": self.client_id_env,
            "registeredRedirectUris": list(self.redirect_uris[environment]),
            "chatAdmission": "reviewed",
            "toolAllowlist": list(self.tool_allowlist),
            "tokenEndpointAuth": self.token_endpoint_auth,
        }
        if self.client_secret_env:
            descriptor["oauthClientSecretEnv"] = self.client_secret_env
        return descriptor


@dataclass(frozen=True)
class CuratedConnectorRegistrationSpec:
    """A reviewed public-client registration contract, never a runtime manifest.

    This has only the OAuth and redirect pins needed to register a client and
    discover its authenticated MCP tools. It intentionally has no descriptor,
    tool policy, descriptor, or deploy-secret surface. Display metadata is
    presentation-only and cannot make this registration contract executable.
    """

    connector_id: str
    display_name: str
    description: str
    mcp_endpoint: str
    authorize_url: str
    token_url: str
    registration_url: str
    scopes: tuple[str, ...]
    token_endpoint_auth: str
    client_id_env: str
    redirect_uris: dict[str, tuple[str, ...]]

    @property
    def is_public_client(self) -> bool:
        return self.token_endpoint_auth == "none"  # noqa: S105 - auth method name

    @property
    def secret_env_names(self) -> tuple[str, ...]:
        """The sole public identifier an operator may store during bootstrap."""
        return (self.client_id_env,)


@dataclass(frozen=True)
class CuratedConnectorCatalogEntry:
    """A reviewed, non-actionable catalog projection.

    This deliberately exposes only cosmetic information and the setup state.
    It has no endpoint, OAuth, secret, tool, or descriptor fields, so rendering
    a card can never widen a provider's runtime authority.
    """

    connector_id: str
    display_name: str
    description: str
    catalog_state: Literal["setup_pending", "discovery_pending"]


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _https(value: Any, label: str) -> str:
    candidate = _text(value)
    try:
        validate_mcp_endpoint(candidate)
    except UnsafeMcpEndpoint:
        raise CuratedConnectorManifestError(f"{label} must be a public HTTPS URL.") from None
    return candidate


def _names(value: Any, label: str, *, allow_empty: bool) -> tuple[str, ...]:
    if (
        not isinstance(value, list)
        or len(value) > _MAX_TOOLS
        or (not value and not allow_empty)
        or not all(isinstance(item, str) and _TOOL_NAME.match(item) for item in value)
        or len(set(value)) != len(value)
    ):
        raise CuratedConnectorManifestError(
            f"{label} must be a list of up to {_MAX_TOOLS} distinct tool names."
        )
    return tuple(value)


def _exact_keys(raw: dict[str, Any], allowed: frozenset[str], label: str) -> None:
    unknown = sorted(set(raw) - allowed)
    if unknown:
        raise CuratedConnectorManifestError(f"{label} has unknown keys: {unknown}.")


def parse_manifest(raw: Any) -> CuratedConnectorManifest:
    """Validate a decoded manifest. Strict by design: unknown keys are errors."""
    if not isinstance(raw, dict) or raw.get("version") != MANIFEST_VERSION:
        raise CuratedConnectorManifestError(f"Manifest version must be {MANIFEST_VERSION}.")
    _exact_keys(raw, _TOP_LEVEL_KEYS, "Manifest")

    connector_id = _text(raw.get("connectorId"))
    if not _CONNECTOR_ID.match(connector_id) or connector_id.startswith(_RESERVED_PREFIXES):
        raise CuratedConnectorManifestError(
            "connectorId must be lowercase snake_case and not start with custom_ or google_."
        )
    display_name = _text(raw.get("displayName"))
    if not display_name:
        raise CuratedConnectorManifestError("displayName is required.")

    oauth = raw.get("oauth")
    if not isinstance(oauth, dict):
        raise CuratedConnectorManifestError("oauth block is required.")
    _exact_keys(oauth, _OAUTH_KEYS, "oauth")
    scopes = oauth.get("scopes")
    # An empty scope list is deliberate for providers that reject a scope parameter.
    if not isinstance(scopes, list) or not all(isinstance(s, str) and _text(s) for s in scopes):
        raise CuratedConnectorManifestError(
            "oauth.scopes must be a list of strings (may be empty)."
        )
    auth_method = _text(oauth.get("tokenEndpointAuth"))
    if auth_method not in _TOKEN_AUTH_METHODS:
        raise CuratedConnectorManifestError(
            f"oauth.tokenEndpointAuth must be one of {list(_TOKEN_AUTH_METHODS)}."
        )

    # Names follow one convention so a mounted secret can never drift from what
    # the runtime reads: <ID>_OAUTH_CLIENT_ID and <ID>_OAUTH_CLIENT_SECRET.
    expected_id_env = f"{connector_id.upper()}_OAUTH_CLIENT_ID"
    expected_secret_env = f"{connector_id.upper()}_OAUTH_CLIENT_SECRET"
    client_id_env = _text(oauth.get("clientIdEnv"))
    if client_id_env != expected_id_env or not _ENV_NAME.match(client_id_env):
        raise CuratedConnectorManifestError(f"oauth.clientIdEnv must be {expected_id_env}.")
    client_secret_env: str | None = _text(oauth.get("clientSecretEnv")) or None
    registration_url: str | None = _text(oauth.get("registrationUrl")) or None
    if auth_method == "none":
        if client_secret_env is not None:
            raise CuratedConnectorManifestError(
                "A public client (tokenEndpointAuth none) must not name a client secret variable."
            )
        if registration_url is None:
            raise CuratedConnectorManifestError(
                "A public client (tokenEndpointAuth none) must declare oauth.registrationUrl."
            )
        registration_url = _https(registration_url, "oauth.registrationUrl")
    elif client_secret_env != expected_secret_env:
        raise CuratedConnectorManifestError(
            f"oauth.clientSecretEnv must be {expected_secret_env} for {auth_method}."
        )
    elif registration_url is not None:
        raise CuratedConnectorManifestError(
            "A confidential client must not declare oauth.registrationUrl."
        )

    tools = raw.get("tools")
    if not isinstance(tools, dict):
        raise CuratedConnectorManifestError("tools block is required.")
    _exact_keys(tools, _TOOLS_KEYS, "tools")
    allowlist = _names(tools.get("allowlist"), "tools.allowlist", allow_empty=False)
    free_read = _names(tools.get("freeRead", []), "tools.freeRead", allow_empty=True)
    stray = sorted(set(free_read) - set(allowlist))
    if stray:
        raise CuratedConnectorManifestError(
            f"tools.freeRead must be a subset of tools.allowlist; not allowed: {stray}."
        )

    environments = raw.get("environments")
    if not isinstance(environments, dict) or not environments:
        raise CuratedConnectorManifestError("environments must name at least one environment.")
    redirect_uris: dict[str, tuple[str, ...]] = {}
    for name, block in environments.items():
        if name not in _ENVIRONMENTS or not isinstance(block, dict):
            raise CuratedConnectorManifestError(f"Unsupported environment {name!r}.")
        _exact_keys(block, frozenset({"registeredRedirectUris"}), f"environments.{name}")
        uris = block.get("registeredRedirectUris")
        if not isinstance(uris, list) or not uris or len(uris) > 8:
            raise CuratedConnectorManifestError(
                f"environments.{name}.registeredRedirectUris must list 1-8 HTTPS addresses."
            )
        redirect_uris[name] = tuple(
            _https(uri, f"environments.{name}.registeredRedirectUris entry") for uri in uris
        )

    return CuratedConnectorManifest(
        connector_id=connector_id,
        display_name=display_name,
        description=_text(raw.get("description")),
        mcp_endpoint=_https(raw.get("mcpEndpoint"), "mcpEndpoint"),
        authorize_url=_https(oauth.get("authorizeUrl"), "oauth.authorizeUrl"),
        token_url=_https(oauth.get("tokenUrl"), "oauth.tokenUrl"),
        registration_url=registration_url,
        scopes=tuple(_text(s) for s in scopes),
        token_endpoint_auth=auth_method,
        client_id_env=client_id_env,
        client_secret_env=client_secret_env,
        tool_allowlist=allowlist,
        free_read_tools=frozenset(free_read),
        redirect_uris=redirect_uris,
    )


def parse_registration_spec(raw: Any) -> CuratedConnectorRegistrationSpec:
    """Validate a public-client registration-only contract.

    Registration happens before an authenticated `tools/list` can establish a
    safe runtime allowlist. Reuse the runtime parser for all OAuth endpoint,
    redirect and env-name validation, but synthesize a private sentinel tool
    list so this spec can never become a usable runtime manifest by accident.
    """
    if not isinstance(raw, dict) or raw.get("version") != REGISTRATION_SPEC_VERSION:
        raise CuratedConnectorManifestError(
            f"Registration spec version must be {REGISTRATION_SPEC_VERSION}."
        )
    _exact_keys(raw, _REGISTRATION_SPEC_TOP_LEVEL_KEYS, "Registration spec")
    oauth = raw.get("oauth")
    if not isinstance(oauth, dict):
        raise CuratedConnectorManifestError("Registration spec oauth block is required.")
    # A registration-only contract is intentionally public PKCE only. A
    # confidential connector must use the normal reviewed runtime manifest and
    # provider-dashboard registration path instead.
    if _text(oauth.get("tokenEndpointAuth")) != "none":
        raise CuratedConnectorManifestError(
            "A registration-only spec must use public tokenEndpointAuth none."
        )
    runtime_shape = {
        "version": MANIFEST_VERSION,
        "connectorId": raw.get("connectorId"),
        "displayName": raw.get("displayName"),
        "description": raw.get("description"),
        "mcpEndpoint": raw.get("mcpEndpoint"),
        "oauth": oauth,
        # The runtime parser requires a nonempty tool list. This private
        # sentinel is never returned or loaded by all_manifests(), and is only
        # used to share strict endpoint/redirect validation.
        "tools": {"allowlist": ["registration_only"], "freeRead": []},
        "environments": raw.get("environments"),
    }
    contract = parse_manifest(runtime_shape)
    if not contract.is_public_client or contract.registration_url is None:
        raise CuratedConnectorManifestError(
            "A registration-only spec must pin a public client registration URL."
        )
    return CuratedConnectorRegistrationSpec(
        connector_id=contract.connector_id,
        display_name=contract.display_name,
        description=contract.description,
        mcp_endpoint=contract.mcp_endpoint,
        authorize_url=contract.authorize_url,
        token_url=contract.token_url,
        registration_url=contract.registration_url,
        scopes=contract.scopes,
        token_endpoint_auth=contract.token_endpoint_auth,
        client_id_env=contract.client_id_env,
        redirect_uris=contract.redirect_uris,
    )


def load_manifest_file(path: str | Path) -> CuratedConnectorManifest:
    manifest_path = Path(path)
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise CuratedConnectorManifestError(
            f"{manifest_path.name} must be a readable JSON object."
        ) from error
    manifest = parse_manifest(raw)
    if manifest_path.stem != manifest.connector_id:
        raise CuratedConnectorManifestError(
            f"{manifest_path.name} must be named {manifest.connector_id}.json."
        )
    return manifest


def load_registration_spec_file(path: str | Path) -> CuratedConnectorRegistrationSpec:
    spec_path = Path(path)
    try:
        raw = json.loads(spec_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise CuratedConnectorManifestError(
            f"{spec_path.name} must be a readable registration spec JSON object."
        ) from error
    spec = parse_registration_spec(raw)
    if spec_path.stem != spec.connector_id:
        raise CuratedConnectorManifestError(
            f"{spec_path.name} must be named {spec.connector_id}.json."
        )
    return spec


@lru_cache(maxsize=1)
def _load_all() -> tuple[dict[str, CuratedConnectorManifest], dict[str, str]]:
    """Each file is loaded on its own, so one bad manifest cannot take down the
    other providers at runtime. Errors are kept so CI can fail on them."""
    manifests: dict[str, CuratedConnectorManifest] = {}
    errors: dict[str, str] = {}
    if not MANIFEST_DIR.is_dir():
        return manifests, errors
    for path in sorted(MANIFEST_DIR.glob("*.json")):
        try:
            manifest = load_manifest_file(path)
        except CuratedConnectorManifestError as error:
            errors[path.name] = str(error)
            continue
        if manifest.connector_id in manifests:
            errors[path.name] = f"duplicate connectorId {manifest.connector_id}."
            continue
        manifests[manifest.connector_id] = manifest
    return manifests, errors


def manifest_errors() -> dict[str, str]:
    """Files that failed validation, by file name. Empty when every manifest is valid."""
    return dict(_load_all()[1])


def all_manifests() -> dict[str, CuratedConnectorManifest]:
    """Every valid checked-in manifest."""
    return dict(_load_all()[0])


def get_manifest(connector_id: str) -> CuratedConnectorManifest | None:
    """The manifest for a provider, or None. A provider whose manifest is missing
    or invalid is never served (fail closed); the registry is never consulted."""
    return _load_all()[0].get(connector_id)


@lru_cache(maxsize=1)
def _load_registration_specs() -> tuple[
    dict[str, CuratedConnectorRegistrationSpec], dict[str, str]
]:
    """Load bootstrap contracts independently of runtime manifests.

    A provider cannot retain both forms: the registration spec must be removed
    when its authenticated tools have produced a real runtime manifest.
    """
    specs: dict[str, CuratedConnectorRegistrationSpec] = {}
    errors: dict[str, str] = {}
    if not REGISTRATION_SPEC_DIR.is_dir():
        return specs, errors
    for path in sorted(REGISTRATION_SPEC_DIR.glob("*.json")):
        try:
            spec = load_registration_spec_file(path)
        except CuratedConnectorManifestError as error:
            errors[path.name] = str(error)
            continue
        if (MANIFEST_DIR / f"{spec.connector_id}.json").exists():
            errors[path.name] = (
                f"{spec.connector_id} has a runtime manifest; remove its registration-only spec."
            )
            continue
        if spec.connector_id in specs:
            errors[path.name] = f"duplicate connectorId {spec.connector_id}."
            continue
        specs[spec.connector_id] = spec
    return specs, errors


def registration_spec_errors() -> dict[str, str]:
    """Invalid registration-only contracts, by file name."""
    return dict(_load_registration_specs()[1])


def all_registration_specs() -> dict[str, CuratedConnectorRegistrationSpec]:
    """Every valid registration-only contract; never a runtime provider list."""
    return dict(_load_registration_specs()[0])


def all_catalog_entries() -> dict[str, CuratedConnectorCatalogEntry]:
    """Every reviewed connector card that may be presented to an owner.

    Runtime manifests stay fail-closed until an exact, active registry row and
    runtime configuration pass their existing checks. Registration-only specs
    stay non-actionable until authenticated tool discovery produces a runtime
    manifest. This is a display projection, never an OAuth or deploy input.
    """
    entries = {
        connector_id: CuratedConnectorCatalogEntry(
            connector_id=manifest.connector_id,
            display_name=manifest.display_name,
            description=manifest.description,
            catalog_state="setup_pending",
        )
        for connector_id, manifest in all_manifests().items()
    }
    entries.update(
        {
            connector_id: CuratedConnectorCatalogEntry(
                connector_id=spec.connector_id,
                display_name=spec.display_name,
                description=spec.description,
                catalog_state="discovery_pending",
            )
            for connector_id, spec in all_registration_specs().items()
        }
    )
    return entries


def get_registration_spec(connector_id: str) -> CuratedConnectorRegistrationSpec | None:
    """The public bootstrap contract for a provider awaiting tool discovery."""
    return _load_registration_specs()[0].get(connector_id)


def clear_manifest_cache() -> None:
    _load_all.cache_clear()


def clear_registration_spec_cache() -> None:
    _load_registration_specs.cache_clear()
