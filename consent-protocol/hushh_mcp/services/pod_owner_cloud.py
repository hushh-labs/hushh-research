"""Whether this process is an agent running in its owner's own cloud.

Connectors that read a person's Google account inside the agent (Gmail, Calendar,
Drive, Contacts) run only in an owner-cloud agent: never in the shared hub, and never
in a Hussh-hosted pod. The answer comes from facts the agent's own deploy renders and
nothing else:

* ``pod_mode()`` must be on, so the shared hub can never answer yes;
* Google: ``HUSSH_POD_KMS_KEY`` names the person's own KMS key, rendered only by
  ``UserGcpBackend`` (``byoc_key_env``), never by the managed renderer;
* Azure: ``HUSSH_POD_KEY_VAULT_KEY`` names the person's own Key Vault key, rendered
  only by ``azure_container_app_renderer``.

Read at call time, never cached, so a test or a redeploy that changes the environment
is seen on the next question. No new environment switch is introduced: these are the
key locations the agent already needs to open its own log.
"""

from __future__ import annotations

import os
from typing import Optional

from hushh_mcp.services.compute_backend import BACKEND_USER_AZURE, BACKEND_USER_GCP

_GCP_KEY_ENV = "HUSSH_POD_KMS_KEY"
_AZURE_KEY_ENV = "HUSSH_POD_KEY_VAULT_KEY"


def owner_cloud_provider() -> Optional[str]:
    """``user_gcp`` or ``user_azure`` inside an owner-cloud agent; None anywhere else."""
    from hushh_mcp.runtime_settings import pod_mode  # noqa: PLC0415

    if not pod_mode():
        return None
    gcp = bool((os.environ.get(_GCP_KEY_ENV) or "").strip())
    azure = bool((os.environ.get(_AZURE_KEY_ENV) or "").strip())
    if gcp == azure:
        # Neither, or a contradictory pair: not provably an owner cloud.
        return None
    return str(BACKEND_USER_GCP if gcp else BACKEND_USER_AZURE)


def owner_cloud_agent() -> bool:
    """True only inside an agent that runs in its owner's own cloud account."""
    return owner_cloud_provider() is not None


def pod_owner_user_id() -> str:
    """The one person this agent serves, from the hub-signed bindings it trusts.

    Every binding the agent holds names its owner's user id. Exactly one distinct id
    across the trusted bindings is the owner; none, or more than one, is no answer
    (empty), and every caller treats empty as "refuse".
    """
    from hushh_mcp.services.pod_authority_store import active_authority_store  # noqa: PLC0415

    store = active_authority_store()
    if store is None:
        return ""
    hushh_id = (os.environ.get("HUSSH_ID") or "").strip()
    owners = {
        str(record.binding.get("user_id") or "").strip()
        for record in store.trusted_subjects()
        if str(record.binding.get("hushh_id") or "").strip() == hushh_id
    }
    owners.discard("")
    return owners.pop() if len(owners) == 1 else ""


__all__ = ["owner_cloud_agent", "owner_cloud_provider", "pod_owner_user_id"]
