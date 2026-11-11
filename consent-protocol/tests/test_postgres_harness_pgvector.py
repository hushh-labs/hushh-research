"""A native cluster without pgvector must skip the tests that need it, never run them."""

from tests.pkm_conformance import postgres_harness as harness


def test_a_cluster_without_pgvector_is_skipped_and_one_with_it_is_used(tmp_path, monkeypatch):
    bin_dir = tmp_path / "lib" / "postgresql" / "16" / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "initdb").write_text("")
    share = tmp_path / "share" / "postgresql"
    extension_dir = share / "16" / "extension"
    extension_dir.mkdir(parents=True)
    monkeypatch.setattr(harness, "_PG_SHARE", share)
    monkeypatch.setattr(harness.glob, "glob", lambda _pattern: [str(bin_dir)])
    monkeypatch.setattr(harness.shutil, "which", lambda _name: None)
    monkeypatch.delenv("HUSHH_TEST_PG_BIN", raising=False)

    assert harness.find_pg_bin() is None

    (extension_dir / "vector.control").write_text("")
    assert harness.find_pg_bin() == str(bin_dir)
