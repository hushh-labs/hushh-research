"""Per-pod sealing keys that survive the pod.

THE PROBLEM THIS EXISTS FOR. A pod's durable state is an encrypted, hash-chained
commit log in an object store (``pod_commit_log``), sealed under
``HUSSH_POD_LOG_KEY``; its memory is sealed under ``HUSSH_POD_MEMORY_KEY``. Both
were operator-supplied and nothing minted them, so no renderer emitted either and
every deployed pod ran with storage ``Null`` and memory off. A pod that is torn
down and re-provisioned came back as a stranger.

For the economy tier that is fatal rather than merely lossy. Economy means
``min-instances=0``: the pod is *expected* to go cold and wake again. If waking
loses everything, the cheap tier is not a cheaper agent, it is a different agent
every time -- and "continues learning over time" is unimplementable.

So the key must be a pure function of the pod's identity, not of its lifetime.

THE DERIVATION. HKDF-SHA256 over one master secret, with the ``hushh_id`` bound
into the ``info`` label and a distinct label per purpose:

    log_key    = HKDF(master, info=b"hussh.pod.commit-log.v1|<hushh_id>")
    memory_key = HKDF(master, info=b"hussh.pod.memory.v1|<hushh_id>")

Two pods never share a key, the two purposes within one pod never share a key
(so the commit log and the memory index cannot interact), and both are
reproducible after any teardown because nothing about them depends on when the
pod ran.

WHAT THIS COSTS, STATED PLAINLY. The holder of the master can re-derive every
pod's keys, and therefore read any hussh-managed pod's sealed history. That is a
real reduction against the Zero-Knowledge posture and it is the deliberate price
of resumable hussh-managed pods. It is bounded three ways:

* The master is its own secret, never ``APP_SIGNING_KEY``. Reusing the consent
  signing key would mean rotating consent tokens silently destroyed every pod's
  history, and would give one compromised value both authorities.
* The master lives in Secret Manager and is mounted into the hub only. A pod
  receives its own two derived keys and never the master, so a compromised pod
  cannot derive a sibling's.
* It is the hussh-MANAGED answer only. On BYO GCP the user's own project holds a
  per-user KMS key and CMEK bucket (``user_gcp_backend.render_bootstrap_plan``),
  and that path keeps the property this one spends. Production Zero-Knowledge is
  BYOC; this makes the managed simulation tier resumable without pretending to be
  something it is not.

Fails loud everywhere. A guessed key silently produces an unreadable log, which
looks exactly like data loss and is discovered only when someone needs the data.
"""

from __future__ import annotations

import base64
import os

POD_KEY_MASTER_ENV = "HUSSH_POD_KEY_MASTER"

_KEY_LEN = 32

# Versioned so a future rotation can derive a v2 alongside a still-readable v1.
_LOG_KEY_INFO = b"hussh.pod.commit-log.v1"
_MEMORY_KEY_INFO = b"hussh.pod.memory.v1"


def _master_material() -> bytes:
    raw = (os.getenv(POD_KEY_MASTER_ENV) or "").strip()
    if not raw:
        raise RuntimeError(
            f"{POD_KEY_MASTER_ENV} is not set -- pod sealing keys are never derived "
            f"from a guessed master"
        )
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            decoded = decoder(raw + "=" * (-len(raw) % 4))
        except Exception:  # noqa: BLE001 - try the next encoding
            continue
        if len(decoded) >= _KEY_LEN:
            return decoded
    # A non-base64 master is accepted as raw UTF-8 so an operator can set a long
    # passphrase, but never a short one: HKDF will happily stretch 4 bytes into 32
    # and produce a key with 4 bytes of entropy.
    material = raw.encode("utf-8")
    if len(material) < _KEY_LEN:
        raise RuntimeError(
            f"{POD_KEY_MASTER_ENV} must be at least {_KEY_LEN} bytes "
            f"(base64 of >={_KEY_LEN} raw bytes, or a >={_KEY_LEN}-character passphrase)"
        )
    return material


def _derive(hushh_id: str, info: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    owner = str(hushh_id or "").strip()
    if not owner:
        raise ValueError("a hushh_id is required; a pod key is never derived for nobody")
    return HKDF(
        algorithm=hashes.SHA256(),
        length=_KEY_LEN,
        salt=None,
        info=info + b"|" + owner.encode("utf-8"),
    ).derive(_master_material())


def derive_pod_log_key(hushh_id: str) -> bytes:
    """The 32-byte key sealing this pod's commit log. Stable for the life of the id."""
    return _derive(hushh_id, _LOG_KEY_INFO)


def derive_pod_memory_key(hushh_id: str) -> bytes:
    """The 32-byte key sealing this pod's memory. Distinct from the log key by label."""
    return _derive(hushh_id, _MEMORY_KEY_INFO)


def pod_log_key_b64(hushh_id: str) -> str:
    """Base64 for transport into the pod's environment (`HUSSH_POD_LOG_KEY`)."""
    return base64.b64encode(derive_pod_log_key(hushh_id)).decode("ascii")


def pod_memory_key_b64(hushh_id: str) -> str:
    """Base64 for transport into the pod's environment (`HUSSH_POD_MEMORY_KEY`)."""
    return base64.b64encode(derive_pod_memory_key(hushh_id)).decode("ascii")


def custody_configured() -> bool:
    """Is a master present? Callers render durable storage only when it is.

    Absence is not an error here -- it is today's behaviour, an ephemeral pod --
    so a deployment that has not been given a master keeps working exactly as it
    did instead of failing to provision.
    """
    return bool((os.getenv(POD_KEY_MASTER_ENV) or "").strip())
