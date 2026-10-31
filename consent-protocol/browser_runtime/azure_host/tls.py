"""Host-owned certificate issuance and atomic renewal. No private-content proxy."""

from __future__ import annotations

import fcntl
import hashlib
import os
import shutil
import ssl
import subprocess
import tempfile
from pathlib import Path

from .config import TLS, HostRefused, load


def install_pair(config: dict) -> None:
    source = Path("/etc/letsencrypt/live") / config["hostname"]
    cert, key = source / "fullchain.pem", source / "privkey.pem"
    # Certbot's own root-owned symlinks are intentional. Copy the resolved pair
    # into one immutable revision, never publish two independently replaced files.
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        subprocess.run(  # noqa: S603 - fixed executable and validated installation values
            [
                "openssl",
                "x509",
                "-in",
                str(cert),
                "-noout",
                "-checkend",
                "86400",
                "-checkhost",
                config["hostname"],
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
        subprocess.run(  # noqa: S603 - fixed executable and validated installation values
            [
                "openssl",
                "verify",
                "-purpose",
                "sslserver",
                "-untrusted",
                str(source / "chain.pem"),
                str(source / "cert.pem"),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
        certificate, private = cert.read_bytes(), key.read_bytes()
        if len(certificate) > 65536 or len(private) > 16384:
            raise ValueError()
        _publish(certificate, private)
    except Exception:
        raise HostRefused("HOST_CERTIFICATE_REFUSED") from None


def _publish(certificate: bytes, private: bytes) -> None:
    """Publish a complete pair once, even after termination or competing renewal."""
    revision = hashlib.sha256(certificate).hexdigest()
    TLS.mkdir(mode=0o750, exist_ok=True)
    os.chown(TLS, 0, 10001)
    os.chmod(TLS, 0o750)  # noqa: S103 - root plus the agent group only
    with open(TLS / ".publish.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        target = TLS / revision
        temporary = Path(tempfile.mkdtemp(prefix=".pending-", dir=TLS))
        try:
            for name, content in (("fullchain.pem", certificate), ("privkey.pem", private)):
                fd = os.open(
                    temporary / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640
                )
                with os.fdopen(fd, "wb") as handle:
                    handle.write(content)
                    handle.flush()
                os.chown(temporary / name, 0, 10001)
                os.chmod(temporary / name, 0o640)
            ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(
                temporary / "fullchain.pem", temporary / "privkey.pem"
            )
            os.chown(temporary, 0, 10001)
            os.chmod(temporary, 0o750)  # noqa: S103 - root plus the agent group only
            if target.exists():
                if (target / "fullchain.pem").read_bytes() != certificate or (
                    target / "privkey.pem"
                ).read_bytes() != private:
                    raise HostRefused("HOST_TLS_REVISION_CHANGED")
            else:
                os.rename(temporary, target)
            pointer = TLS / "next"
            pointer.unlink(missing_ok=True)
            pointer.symlink_to(revision)
            previous = os.readlink(TLS / "current") if (TLS / "current").is_symlink() else None
            os.replace(pointer, TLS / "current")
            # One previous pair covers already-started handshakes. Pending
            # directories from a killed publisher are safe to discard under lock.
            for entry in TLS.iterdir():
                if (
                    entry.is_dir()
                    and not entry.is_symlink()
                    and entry.name not in {revision, previous}
                ):
                    shutil.rmtree(entry)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)


def ensure(config: dict) -> None:
    try:
        subprocess.run(  # noqa: S603 - fixed executable and validated installation values
            [
                "certbot",
                "certonly",
                "--standalone",
                "--non-interactive",
                "--agree-tos",
                "--register-unsafely-without-email",
                "--keep-until-expiring",
                "--cert-name",
                config["hostname"],
                "-d",
                config["hostname"],
            ],
            check=True,
            timeout=180,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        install_pair(config)
    except HostRefused:
        raise
    except Exception:
        raise HostRefused("HOST_CERTIFICATE_UNAVAILABLE") from None


if __name__ == "__main__":
    try:
        install_pair(load())
    except Exception:
        raise SystemExit("HOST_CERTIFICATE_REFUSED") from None
