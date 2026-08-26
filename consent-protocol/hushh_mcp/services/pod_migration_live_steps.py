"""The concrete migration steps: the sequencer's ten methods against real work.

``run_migration`` (``pod_migration_service``) owns the ORDER and the rollback
argument; it drives an object satisfying the ``MigrationSteps`` protocol. Until
now the only such object was the test fake, so the sequencer had no way to touch
real infrastructure. This is the real one.

WHY IT COMPOSES INJECTED COLLABORATORS RATHER THAN CALLING SUBSYSTEMS DIRECTLY
-----------------------------------------------------------------------------
Each of the ten steps maps to a subsystem -- the registry's freeze/unfreeze, the
provisioner, the pod key collector, the two-token transport, the run client's
delete. Wiring those as constructor collaborators, exactly as ``run_migration``
takes its steps injected, keeps this object unit-testable end to end (drive the
whole chain with fakes and assert the order, the data threading, and the rollback)
and keeps the composition root -- where the real services are built -- in one
honest place: the operator rehearsal, and later the hub route. A live migration
that can only be exercised against two real cloud projects is a migration whose
rollback paths are first tested on a real person's agent, which is the most
expensive place to find a bug.

WHAT IT MAY NOT DO
------------------
It never opens the bundle. The transport carries ciphertext the hub cannot read,
and the verification is a head-hash comparison ``run_migration`` performs with no
key. This object threads the sealed envelope from ``export_source`` to
``import_destination`` and never inspects it.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Protocol

logger = logging.getLogger(__name__)


class DestinationProvisioner(Protocol):
    """The destination-side work, injected so the composition root owns which
    real services back it (BYOC substrate, provisioning service, key collector)."""

    async def prepare(self) -> None:
        """Ensure the destination substrate exists (image copy, bucket, keyring)."""
        ...

    async def create(self) -> str:
        """Provision the destination pod for the SAME HusshID and return its URL.
        Adopt-shaped, never identity-re-minting."""
        ...

    async def collect_key(self) -> tuple[str, str]:
        """Pull the destination pod's published X25519 key. Returns (public, id)."""
        ...

    async def teardown(self) -> None:
        """Remove a half-built destination on a pre-switch failure."""
        ...


class RegistryPort(Protocol):
    async def begin_migration(self, user_id: str) -> bool: ...
    async def end_migration(self, user_id: str, *, status: str = "provisioned") -> bool: ...


@dataclass(frozen=True)
class MigrationContext:
    user_id: str
    hushh_id: str
    source_pod_url: str
    source_service: str


class LiveMigrationSteps:
    """A concrete ``MigrationSteps`` for ``run_migration``.

    ``transport`` is the ``pod_migration_transport`` module (or a stand-in); its
    ``export_from``/``import_into`` are synchronous, so they run on a thread here
    because the sequencer awaits every step. ``token_minter`` is threaded into the
    transport so an operator can drive it from a shell (no metadata server).
    ``reap`` is a zero-arg callable that deletes the source host and NOTHING else
    -- the reconcile worker's host-teardown doctrine, never account teardown.
    ``switch_over`` is a callable that flips the registry row to the destination.
    """

    def __init__(
        self,
        ctx: MigrationContext,
        *,
        registry: RegistryPort,
        provisioner: DestinationProvisioner,
        transport: Any,
        reap: Any,
        switch_over: Any,
        token_minter: Any = None,
    ) -> None:
        self._ctx = ctx
        self._registry = registry
        self._provisioner = provisioner
        self._transport = transport
        self._reap = reap
        self._switch_over = switch_over
        self._token_minter = token_minter
        # Captured when the destination is created; the sequencer passes the URL
        # back into switch_over, but import_destination needs it too.
        self._destination_url = ""

    async def freeze(self) -> bool:
        # Conditional on the row being `provisioned`; a False here is "not ready
        # to move" and the sequencer stops before touching anything.
        return await self._registry.begin_migration(self._ctx.user_id)

    async def unfreeze(self) -> None:
        await self._registry.end_migration(self._ctx.user_id)

    async def prepare_destination(self) -> None:
        await self._provisioner.prepare()

    async def create_destination(self) -> str:
        self._destination_url = await self._provisioner.create()
        return self._destination_url

    async def collect_destination_key(self) -> tuple[str, str]:
        return await self._provisioner.collect_key()

    async def export_source(self, public_key: str, key_id: str) -> dict[str, Any]:
        # Sealed to the destination's key, on a thread because the transport is
        # synchronous. The hub carries the returned envelope and cannot open it.
        return await asyncio.to_thread(
            self._transport.export_from,
            pod_url=self._ctx.source_pod_url,
            hushh_id=self._ctx.hushh_id,
            recipient_public_key=public_key,
            recipient_key_id=key_id,
            token_minter=self._token_minter,
        )

    async def import_destination(self, bundle: dict[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._transport.import_into,
            pod_url=self._destination_url,
            hushh_id=self._ctx.hushh_id,
            bundle=bundle,
            token_minter=self._token_minter,
        )

    async def switch_over(self, destination_url: str) -> None:
        # The point of no return, taken only after the head-hash proof. Identity
        # (HusshID, phone hash, A2A) is untouched; only the cloud coordinates and
        # the host handle move.
        await _maybe_await(self._switch_over(destination_url))

    async def reap_source(self) -> None:
        # Host-teardown only. Never the identity, never a tombstone.
        await _maybe_await(self._reap())

    async def rollback_destination(self) -> None:
        await self._provisioner.teardown()


async def _maybe_await(value: Any) -> Any:
    """Await a coroutine, or pass a plain value through, so a collaborator may be
    sync or async without the caller caring."""
    if asyncio.iscoroutine(value):
        return await value
    return value


__all__ = [
    "DestinationProvisioner",
    "RegistryPort",
    "MigrationContext",
    "LiveMigrationSteps",
]
