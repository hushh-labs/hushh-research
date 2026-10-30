"""Public PostgreSQL delivery facade; all operons share this transaction port.

Graph/request/contract locking and the inherited transaction runner remain the
only mutation authority. Capability modules never construct a second store.
"""

from hushh_mcp.services.drive_sharing_store import DriveSharingStore

from . import (
    activity,
    approval,
    checkout,
    intake,
    keys,
    packages,
    projections,
    selection,
    transaction,
    uploads,
)
from . import release as release_ops
from .state import deadline as deadline
from .state import delivery_summary as delivery_summary
from .state import has_contract as has_contract
from .state import iso as iso


class DocumentDeliveryStore(DriveSharingStore):
    """Compatibility API composing explicit transaction-scoped capabilities."""

    schema_ready = staticmethod(transaction.schema_ready)
    _locked = transaction._locked
    _current = staticmethod(transaction._current)
    _revision = staticmethod(transaction._revision)
    _idempotent = transaction._idempotent
    _result = transaction._result
    _no_payment_attempt = staticmethod(transaction._no_payment_attempt)
    _selection = selection._selection
    _candidates = selection._candidates
    source_selection = selection.source_selection
    source_authority = selection.source_authority
    _document_owner_setup = selection._document_owner_setup
    _projection = projections._projection
    projection = projections.projection
    payment_state_locked = projections.payment_state_locked
    create = intake.create
    approve = approval.approve
    stage_package = packages.stage_package
    reserve_upload = uploads.reserve_upload
    upload_authority = uploads.upload_authority
    attach_upload_session = uploads.attach_upload_session
    upload_session = uploads.upload_session
    dispatch_upload = uploads.dispatch_upload
    upload_result = uploads.upload_result
    _public_key = keys._public_key
    recipient_key = keys.recipient_key
    issue_challenge = keys.issue_challenge
    verify_challenge = keys.verify_challenge
    _ensure_payment_order = checkout._ensure_payment_order
    checkout_authority = checkout.checkout_authority
    accept_checkout = checkout.accept_checkout
    _paid = checkout._paid
    release_locked = release_ops.release_locked
    release = release_ops.release
    artifact_authority = release_ops.artifact_authority
    _enqueue_cleanup = staticmethod(activity._enqueue_cleanup)
    _audit = staticmethod(activity._audit)
    record_activity = activity.record_activity
    activities = activity.activities
    revoke = activity.revoke
