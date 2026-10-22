"""Which placement signed a pod request, and whether its epoch is current (E4).

``docs/future/personal-agent/STANDBY-SYNC.md`` engineering decision E4. A person may
have a primary agent and one synced standby, both speaking for the same HusshID. The
hub tells them apart by KEY, and fences a switch by EPOCH:

- turn and write paths accept only the registry row's ``pod_signing_key_id`` (the
  primary); the standby's key id is accepted only on sync paths;
- once a person has a standby or ``placement_epoch > 0``, a signed request without
  ``X-Hushh-Pod-Epoch``, or with an epoch below the registry's, is refused.

Every refusal here becomes the verifier's ``INVALID``. No new outcome exists, so
nothing decided here can fall through to the transitional Google-token path.

A registry row read from a schema without dev-only migration 950 has no
``placement_epoch`` key at all; that row is unfenced and no standby is read, which
is today's behaviour exactly. With 950, an unreadable standby is a refusal: the hub
cannot prove which placement is speaking, so it does not guess.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)

EPOCH_COLUMN = "placement_epoch"


@dataclass(frozen=True)
class PlacementFence:
    """The registry's epoch and the standby's public signing key, if any."""

    epoch: int = 0
    standby_key_id: str = ""
    standby_public_key: str = ""

    @property
    def fenced(self) -> bool:
        return self.epoch > 0 or bool(self.standby_key_id)


UNFENCED = PlacementFence()


@dataclass(frozen=True)
class KeyChoice:
    """The key a fenced request must verify under, or why it is refused."""

    refusal: Optional[str] = None
    standby: bool = False
    public_key: str = ""
    needs_pull: bool = False


def row_epoch(row: Optional[dict]) -> Optional[int]:
    """The registry row's placement epoch: 0 when the column is absent, None if malformed."""
    if not isinstance(row, dict) or EPOCH_COLUMN not in row:
        return 0
    value = row.get(EPOCH_COLUMN)
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


async def read_placement_fence(row: dict, standbys: Any) -> Optional[PlacementFence]:
    """The fence for this registry row, or None when it cannot be established.

    ``standbys`` is the hub's standby reader. The production caller
    (``api/routes/one/pod_identity_auth``) always supplies one. Without a reader only
    the row's own epoch can fence (an epoch above 0 still demands the header and
    never admits a standby key); that is the contract for direct callers of the
    verifier that predate 950, not a mode any route runs in.
    """
    if EPOCH_COLUMN not in row:
        return UNFENCED
    epoch = row_epoch(row)
    if epoch is None:
        logger.warning("pod_placement_fence.unavailable reason=epoch_malformed")
        return None
    if standbys is None:
        return PlacementFence(epoch=epoch)
    try:
        standby = await standbys.read_standby(str(row.get("user_id") or ""))
    except Exception as exc:  # noqa: BLE001 - cannot rule a standby out: refuse
        logger.warning("pod_placement_fence.standby_read_failed %s", type(exc).__name__)
        return None
    if standby is None:
        return PlacementFence(epoch=epoch)
    key_id = str(standby.get("pod_signing_key_id") or "").strip()
    public_key = str(standby.get("pod_signing_pubkey") or "").strip()
    if standby.get("hushh_id") != row.get("hushh_id") or not key_id or not public_key:
        logger.warning("pod_placement_fence.unavailable reason=standby_shape")
        return None
    return PlacementFence(epoch=epoch, standby_key_id=key_id, standby_public_key=public_key)


def epoch_refusal(fence: PlacementFence, signed_epoch: Optional[int]) -> Optional[str]:
    """Why this request's epoch is not acceptable for the fence, or None."""
    if not fence.fenced:
        return None
    if signed_epoch is None:
        return "epoch_missing"
    if signed_epoch < fence.epoch:
        return "epoch_stale"
    return None


def choose_key(fence: PlacementFence, row: dict, kid: str, *, sync_path: bool) -> KeyChoice:
    """Pick the placement key a fenced request names, by path class."""
    primary_kid = str(row.get("pod_signing_key_id") or "").strip()
    primary_key = str(row.get("pod_signing_pubkey") or "").strip()
    if fence.standby_key_id and fence.standby_key_id == primary_kid:
        return KeyChoice(refusal="placement_keys_ambiguous")
    if kid == fence.standby_key_id:
        if not sync_path:
            return KeyChoice(refusal="standby_key_on_primary_path")
        return KeyChoice(standby=True, public_key=fence.standby_public_key)
    if kid == primary_kid:
        return KeyChoice(public_key=primary_key)
    return KeyChoice(needs_pull=True)
