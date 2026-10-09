"""Fixed projection adapters for the crypto-erasure CAS race proof."""

from hushh_mcp.services.pod_recovery_projection import KEY as OWNER_KEY
from hushh_mcp.services.pod_recovery_projection import OwnerRecoveryProjection
from hushh_mcp.services.pod_reply_notifications import KEY as REPLY_KEY
from hushh_mcp.services.pod_reply_notifications import PodReplyOutbox


def erasure_projection(reply, log, owner):
    if reply:
        projection = PodReplyOutbox(log)
        return REPLY_KEY, projection._snapshot, projection._snapshot
    projection = OwnerRecoveryProjection(owner=owner)

    async def prepare():
        await projection.replay(log)

    async def save():
        await projection.recover(log, force_save=True)

    return OWNER_KEY, prepare, save
