"""Held-out data is split by family, frozen by content hash, and burned when viewed."""

from hushh_eval.drive_packets.partition import (
    BurnList,
    assign,
    family_key,
    partition_for,
)

SALT = b"s" * 32


def family(issuer, account, kind="Monthly statement"):
    return family_key(
        SALT, issuer=issuer, account=account, subject=None, document_type=kind, fallback="folder"
    )


def test_one_family_never_spans_dev_and_heldout(tmp_path):
    burn = BurnList(tmp_path / "burned.jsonl")
    families = [family("Bank", f"Account ending {index:04d}") for index in range(200)]
    partitions = {}
    for index, key in enumerate(families * 3):
        partition, _ = partition_for(
            SALT, burn, family=key, file_key=f"f{index}", content_sha256=None, frozen_sha256=None
        )
        assert partitions.setdefault(key, partition) == partition
    heldout = sum(value == "heldout" for value in partitions.values())
    assert 30 <= heldout <= 90  # about 30% of 200 families
    # Same issuer and account last 4 are one family regardless of formatting.
    assert family("BANK, Inc", "xx-1234") == family("bank inc", "Account ending 1234")


def test_burned_items_stay_dev_forever(tmp_path):
    burn = BurnList(tmp_path / "burned.jsonl")
    key = next(
        family("Bank", f"{n:04d}")
        for n in range(500)
        if assign(SALT, family("Bank", f"{n:04d}")) == "heldout"
    )
    burn.burn("file-a", "seven_source")
    assert partition_for(
        SALT, burn, family=key, file_key="file-a", content_sha256=None, frozen_sha256=None
    ) == ("dev", "burned")
    # The burn list is durable.
    assert BurnList(tmp_path / "burned.jsonl").burned("file-a")


def test_changed_original_is_excluded_from_heldout(tmp_path):
    burn = BurnList(tmp_path / "burned.jsonl")
    result = partition_for(
        SALT, burn, family="f", file_key="file-b", content_sha256="new", frozen_sha256="old"
    )
    assert result == ("dev", "source_changed")


def test_viewing_a_heldout_item_burns_it_and_is_logged(tmp_path):
    path = tmp_path / "burned.jsonl"
    burn = BurnList(path)
    burn.view_heldout(case_key="file-c", content_sha256="abc")
    assert burn.burned("file-c") and burn.burned("abc")
    assert '"reason": "viewed"' in path.read_text()
