from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from hussh_sdk.errors import RuntimeConfigError, RuntimeCredentialMissingError
from hussh_sdk.models import RuntimeConfig

SecretReader = Callable[[str], str | None | Awaitable[str | None]]


@dataclass(frozen=True)
class ResolvedCredential:
    credential_ref: str
    secret: str
    source: str

    def evidence(self) -> dict:
        return {
            "credential_ref": self.credential_ref,
            "credential_resolved": True,
            "resolution_source": self.source,
            "credential_packaged": False,
        }


@runtime_checkable
class CredentialResolver(Protocol):
    async def resolve(self, credential_ref: str) -> ResolvedCredential | None:
        """Resolve a credential_ref to a runtime-only secret."""
        ...


@runtime_checkable
class VaultSession(Protocol):
    async def read_secret(self, credential_ref: str) -> str | None:
        """Read a secret from an already-unlocked user vault."""
        ...


@runtime_checkable
class PKMSession(Protocol):
    async def read_secret(self, credential_ref: str) -> str | None:
        """Read a secret from an already-unlocked Personal Knowledge Model."""
        ...


@dataclass(frozen=True)
class RuntimeCredentialBundle:
    credential: ResolvedCredential | None
    evidence: dict


class VaultCredentialResolver:
    """
    Resolve BYOK secrets from an already-unlocked user vault.

    The SDK does not unlock the vault. The host app passes either a vault session
    with read_secret(), a read_secret callback, or a decrypted vault mapping.
    """

    def __init__(
        self,
        vault: VaultSession | Mapping[str, Any] | None = None,
        *,
        read_secret: SecretReader | None = None,
        source: str = "user_vault",
    ):
        if vault is None and read_secret is None:
            raise RuntimeConfigError("VaultCredentialResolver requires vault or read_secret.")
        self.vault = vault
        self.read_secret = read_secret
        self.source = source

    async def resolve(self, credential_ref: str) -> ResolvedCredential | None:
        secret = await self._read_secret(credential_ref)
        if not secret:
            return None
        return ResolvedCredential(
            credential_ref=credential_ref,
            secret=secret,
            source=self.source,
        )

    async def _read_secret(self, credential_ref: str) -> str | None:
        if self.read_secret is not None:
            return await _maybe_await(self.read_secret(credential_ref))

        if isinstance(self.vault, Mapping):
            return _read_mapping_secret(self.vault, credential_ref, prefixes=("vault:", "pkm:"))

        if self.vault is not None and hasattr(self.vault, "read_secret"):
            return await _maybe_await(self.vault.read_secret(credential_ref))

        return None


class PKMCredentialResolver(VaultCredentialResolver):
    """
    Resolve BYOK secrets from an already-unlocked Personal Knowledge Model.

    Expected refs look like:
    pkm:runtime_secrets.llm.gemini_api_key
    """

    def __init__(
        self,
        pkm: PKMSession | Mapping[str, Any] | None = None,
        *,
        read_secret: SecretReader | None = None,
        source: str = "user_pkm",
    ):
        super().__init__(pkm, read_secret=read_secret, source=source)


def validate_runtime_config(runtime: RuntimeConfig | None) -> None:
    if runtime is None:
        raise RuntimeConfigError("RuntimeConfig is required.")

    model = runtime.model
    if model.mode == "byok" and not model.credential_ref:
        raise RuntimeConfigError("BYOK runtime requires model.credential_ref.")

    if model.mode == "none" and model.credential_ref:
        raise RuntimeConfigError("mode='none' runtimes must not include model.credential_ref.")

    if model.provider == "local" and model.mode != "none":
        raise RuntimeConfigError("provider='local' runtimes must use mode='none'.")


async def resolve_runtime_credential(
    runtime: RuntimeConfig,
    *,
    resolver: CredentialResolver,
    required: bool = False,
) -> ResolvedCredential | None:
    validate_runtime_config(runtime)

    credential_ref = runtime.model.credential_ref
    if runtime.model.mode != "byok":
        return None

    if not credential_ref:
        if required:
            raise RuntimeCredentialMissingError(credential_ref)
        return None

    credential = await resolver.resolve(credential_ref)
    if credential is None and required:
        raise RuntimeCredentialMissingError(credential_ref)
    return credential


async def prepare_runtime_credentials(
    runtime: RuntimeConfig,
    *,
    resolver: CredentialResolver,
    required: bool = True,
) -> RuntimeCredentialBundle:
    credential = await resolve_runtime_credential(
        runtime,
        resolver=resolver,
        required=required,
    )
    return RuntimeCredentialBundle(
        credential=credential,
        evidence=build_runtime_evidence(runtime, credential=credential),
    )


def build_runtime_evidence(
    runtime: RuntimeConfig,
    *,
    credential: ResolvedCredential | None = None,
) -> dict:
    validate_runtime_config(runtime)

    model = runtime.model
    if credential is not None and credential.credential_ref != model.credential_ref:
        raise RuntimeConfigError("Resolved credential does not match runtime model.credential_ref.")

    credential_evidence = (
        credential.evidence()
        if credential is not None
        else {
            "credential_ref": model.credential_ref,
            "credential_resolved": False,
            "resolution_source": None,
            "credential_packaged": False,
        }
    )
    return {
        "framework": runtime.framework,
        "deployment_target": runtime.deployment_target,
        "model": {
            "mode": model.mode,
            "provider": model.provider,
            "model": model.model,
            **credential_evidence,
        },
    }


async def _maybe_await(value: str | None | Awaitable[str | None]) -> str | None:
    if inspect.isawaitable(value):
        return await value
    return value


def _read_mapping_secret(
    vault: Mapping[str, Any],
    credential_ref: str,
    *,
    prefixes: tuple[str, ...],
) -> str | None:
    path = credential_ref
    for prefix in prefixes:
        if path.startswith(prefix):
            path = path.removeprefix(prefix)
            break

    current: Any = vault
    for key in path.split("."):
        if not key:
            return None
        if not isinstance(current, Mapping) or key not in current:
            return None
        current = current[key]
    return current if isinstance(current, str) else None
