"""Real SQL/HTTP copy lifecycle. Provider and object transport alone are synthetic."""

# ruff: noqa: F811 -- shared isolated PostgreSQL fixtures

import pytest

from hushh_mcp.services.document_delivery.contracts import (
    DeliveryError,
    digest,
)
from tests.helpers.document_delivery_client import (
    new_request,
    pay,
    stage,
)
from tests.helpers.document_delivery_recovery import (
    assert_recovery_provenance,
    prove_replacement_key,
    read_owner_recovery_package,
    replacement_amendment,
)
from tests.services.test_document_delivery import (  # noqa: F401
    connector_postgres_url,
    delivery_app,
    delivery_system,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["one", "both"])
async def test_key_recovery_preserves_paid_content_and_original_money_binding(
    delivery_system, delivery_app, mode
):
    from hushh_mcp.services.document_delivery.contracts import RecoveryAmendment

    system = delivery_system
    request_id = (await new_request(system, mode=mode))["requestId"]
    staged = await stage(system, request_id)
    await pay(system, request_id, staged.package)
    await system.store.release(request_id=request_id, actor="recipient")
    owner_package = await read_owner_recovery_package(system, request_id, staged, delivery_app)
    public = await prove_replacement_key(system, request_id)
    terms, body = replacement_amendment(owner_package, staged, public)
    wrong_terms = {**terms, "amountCents": 2501}
    with pytest.raises(DeliveryError, match="recovery_terms_changed"):
        await system.service.recovery_amendment(
            request_id=request_id,
            actor="owner",
            body=RecoveryAmendment.model_validate(
                {**body, "terms": wrong_terms, "termsDigest": digest(wrong_terms)}
            ),
        )
    await system.service.recovery_amendment(
        request_id=request_id, actor="owner", body=RecoveryAmendment.model_validate(body)
    )
    await assert_recovery_provenance(system, request_id, staged, owner_package, mode)
