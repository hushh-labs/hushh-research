"""The pod's own X25519 keypair, and the public half it is willing to publish.

The pod generates its OWN keypair inside its own runtime and the private half
never leaves this process -- that is what makes Hushh structurally unable to
decrypt the pod's holdings
(:mod:`hushh_mcp.services.pod_connector_keypair_service`).

WHY THE POD PUBLISHES RATHER THAN PUSHES. An earlier shape had the pod POST its
key to the hub. That required the hub to answer "which pod is calling?", and it
cannot: every pod runs as the same service account, so an ID token proves fleet
membership and nothing more. Closing that gap needed a per-pod bearer secret
rendered into the pod's deploy config -- which put secret material into an
artifact readable by anyone with ``run.services.get``, and
``test_rendered_config_carries_identity_but_no_secrets`` correctly refused it.

Inverting the direction removes the question instead of answering it. The pod
merely *exposes* its public key; the HUB fetches it, from the URL the hub itself
recorded in ``backend_metadata`` when it created the service. The address is
never supplied by the caller, so there is no identity to assert and nothing to
forge: whatever answers that URL is by definition that user's pod. No shared
secret, no bearer token, and nothing sensitive in the deploy artifact.

A public key is public, so the endpoint carries no authorization of its own. Pods
are ``internal`` ingress with no ``allUsers`` binding, so only the hub can reach
it regardless.

THE KEY IS PROCESS-LOCAL, AND THAT IS A REAL LIMITATION. It lives in memory and
nowhere else, so a restart produces a NEW keypair. The hub refuses to rebind a
row to a different key (see ``attach_pod_public_key``), so a restarted pod whose
key was already recorded keeps serving with a key the hub no longer agrees with.
Nothing is broken by that today because nothing has yet been wrapped TO the pod's
key -- it is recorded, not used. Persisting it is the open work and it needs a
place a pod can keep a secret across restarts that the hub cannot read: a mounted
per-pod secret, or the attested tier's sealed storage (roadmap M5). Generating an
ephemeral key and calling it durable would be worse than the current state: it
would make the registry's record of "this agent's key" quietly stop being true.
"""

from __future__ import annotations

from typing import Optional

from hushh_mcp.services.pod_connector_keypair_service import PodKeyPair, generate_pod_keypair

# This pod's keypair for the life of the process. Module-level because every
# consumer inside the pod must see the same key, and because there is deliberately
# no way to reload or replace it (see the docstring).
_KEYPAIR: Optional[PodKeyPair] = None


def pod_keypair() -> PodKeyPair:
    """This pod's keypair, generated on first use."""
    global _KEYPAIR
    if _KEYPAIR is None:
        _KEYPAIR = generate_pod_keypair()
    return _KEYPAIR


def pod_public_key_payload() -> dict[str, str]:
    """The public half, in the shape the hub's collector expects.

    Only ever the public key, the key id, and the wrapping algorithm. There is no
    code path here that can reach the private half.
    """
    keypair = pod_keypair()
    return {
        "podPublicKey": keypair.public_key_b64,
        "podKeyId": keypair.key_id,
        "podKeyWrappingAlg": keypair.wrapping_alg,
    }
