"""The subscriber must not learn who the person is.

The pairing handshake exists so a brand can read fields a human granted without
learning their identity. The read path returned the owner's raw Firebase uid on
every response, which handed that identity over directly and - worse - gave any
two brands holding grants from the same person a shared key to join on.

These tests pin the properties that make the replacement safe.
"""

from __future__ import annotations

from hushh_mcp.services.fabric_grant_service import subject_ref

_ALICE = "firebase-uid-alice"
_BOB = "firebase-uid-bob"


def test_same_pair_is_stable():
    """A subscriber must recognise the same person across reads, or it cannot
    apply a preference it was granted."""
    a = subject_ref(subscriber_id="acme", user_id=_ALICE)
    b = subject_ref(subscriber_id="acme", user_id=_ALICE)
    assert a == b


def test_two_subscribers_cannot_join_on_the_same_human():
    """The whole point. Alice presents a different reference to each brand, so
    comparing notes reveals nothing."""
    acme = subject_ref(subscriber_id="acme", user_id=_ALICE)
    globex = subject_ref(subscriber_id="globex", user_id=_ALICE)
    assert acme != globex


def test_two_humans_are_distinct_to_one_subscriber():
    assert subject_ref(subscriber_id="acme", user_id=_ALICE) != subject_ref(
        subscriber_id="acme", user_id=_BOB
    )


def test_the_owner_uid_does_not_appear_in_the_reference():
    """A pseudonym that contains the identifier is not a pseudonym."""
    ref = subject_ref(subscriber_id="acme", user_id=_ALICE)
    assert _ALICE not in ref
    assert "alice" not in ref.lower()


def test_delimiter_confusion_cannot_collide_two_people():
    """Without length-prefixing the subscriber id, ("acme", "b:carol") and
    ("acme:b", "carol") concatenate to the same material and two different
    people would share one reference."""
    assert subject_ref(subscriber_id="acme", user_id="b:carol") != subject_ref(
        subscriber_id="acme:b", user_id="carol"
    )


def test_reference_is_opaque_and_bounded():
    ref = subject_ref(subscriber_id="acme", user_id=_ALICE)
    assert ref.startswith("sub_")
    assert len(ref) == len("sub_") + 32
    assert all(c in "0123456789abcdef" for c in ref[4:])
