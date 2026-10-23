"""Mailbox slot policy without provider/network or platform-specific log adapters."""

from types import SimpleNamespace

import pytest

from hushh_mcp.services.pod_mail_accounts import connection_slot, credential_key, public_account_id


def mailbox(subject, slot="", credential="old"):
    return SimpleNamespace(
        connector_id="gmail", account_subject=subject, account_id=slot, credential_id=credential
    )


def intent(mode="add", **fields):
    return SimpleNamespace(
        connector_id="gmail", mail_account={"mode": mode, **fields}, credential_id="new"
    )


def test_add_preserves_default_and_reconnect_is_bound_to_identity_and_credential():
    work = mailbox("workspace-subject")
    default_slot, previous = connection_slot({}, intent(), "workspace-subject")
    assert (default_slot, previous) == ("", None)
    personal_slot, previous = connection_slot({"gmail": work}, intent(), "personal-subject")
    assert personal_slot and previous is None
    personal = mailbox("personal-subject", personal_slot, "personal-old")
    held = {"gmail": work, credential_key("gmail", personal_slot): personal}
    with pytest.raises(ValueError, match="ALREADY_CONNECTED"):
        connection_slot(held, intent(), "workspace-subject")
    reconnect = intent(
        "reconnect", accountId=public_account_id(personal), credentialId="personal-old"
    )
    assert connection_slot(held, reconnect, "personal-subject") == (personal_slot, personal)
    reconnect.credential_id = work.credential_id
    with pytest.raises(ValueError, match="CHANGED"):
        connection_slot(held, reconnect, "personal-subject")
    reconnect.credential_id = "new"
    with pytest.raises(ValueError, match="MISMATCH"):
        connection_slot(held, reconnect, "workspace-subject")
    reconnect.mail_account["credentialId"] = "stale"
    with pytest.raises(ValueError, match="CHANGED"):
        connection_slot(held, reconnect, "personal-subject")
    assert held["gmail"] is work
    # Removing the default must not strand the owner: a new sign-in can fill
    # that vacant slot without changing the additional mailbox.
    assert connection_slot(
        {credential_key("gmail", personal_slot): personal}, intent(), "workspace-subject"
    ) == ("", None)


def test_add_cannot_reuse_a_credential_or_overflow_or_alias_another_connector():
    work = mailbox("workspace-subject", credential="new")
    with pytest.raises(ValueError, match="CHANGED"):
        connection_slot({"gmail": work}, intent(), "personal-subject")
    held = {str(i): mailbox(str(i), f"{i:032x}", f"old-{i}") for i in range(20)}
    with pytest.raises(ValueError, match="LIMIT"):
        connection_slot(held, intent(), "twenty-first")
    for connector, account in [("drive", "a" * 32), ("gmail", "bad/slot")]:
        with pytest.raises(ValueError):
            credential_key(connector, account)
