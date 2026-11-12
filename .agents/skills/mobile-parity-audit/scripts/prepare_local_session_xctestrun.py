#!/usr/bin/env python3
"""Prepare a safe, adjacent copy of a generated runner-only simulator xctestrun."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import plistlib
import re
import stat
import tempfile
from pathlib import Path
from typing import Any


ALLOWED_SMOKE_FLAGS = frozenset(
    {
        "HUSHH_RUN_LOCAL_SESSION_SMOKE",
        "HUSHH_RUN_NATIVE_CHROME_SMOKE",
        "HUSHH_RUN_WALLET_WARM_SESSION",
    }
)
FORBIDDEN_AUT_FIELDS = frozenset(
    {
        "UITargetAppPath",
        "UITargetAppBundleIdentifier",
        "TestTargetID",
        "TestTargetName",
        "MacroExpansion",
    }
)
ENVIRONMENT_FIELDS = frozenset(
    {
        "EnvironmentVariables",
        "TestingEnvironmentVariables",
        "UITargetAppEnvironmentVariables",
    }
)
SDK_TARGET_APP_ENVIRONMENT_KEYS = frozenset(
    {
        "APP_DISTRIBUTOR_ID_OVERRIDE",
        "DYLD_FRAMEWORK_PATH",
        "DYLD_LIBRARY_PATH",
        "XCODE_SCHEME_NAME",
        "__XCODE_BUILT_PRODUCTS_DIR_PATHS",
        "__XPC_DYLD_FRAMEWORK_PATH",
        "__XPC_DYLD_LIBRARY_PATH",
    }
)
SDK_TARGET_APP_PATH_KEYS = frozenset(
    {
        "DYLD_FRAMEWORK_PATH",
        "DYLD_LIBRARY_PATH",
        "__XCODE_BUILT_PRODUCTS_DIR_PATHS",
        "__XPC_DYLD_FRAMEWORK_PATH",
        "__XPC_DYLD_LIBRARY_PATH",
    }
)
RUNNER_ONLY_SCHEME = "App-SessionAdmission-RunnerOnly"
APP_DISTRIBUTOR_ID_PATTERN = re.compile(r"com\.apple\.[A-Za-z0-9_-]{1,64}\Z")
SENSITIVE_ENV_PARTS = (
    "PASSWORD",
    "PASSPHRASE",
    "SECRET",
    "CREDENTIAL",
    "REVIEWER",
    "OWNERAUTHORIZED",
    "RECOVERYKEY",
    "APITOKEN",
    "APIKEY",
)


class PreparationError(Exception):
    """A fail-closed, safe-to-print preparation failure code."""


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        del message
        print(json.dumps({"ok": False, "error": "arguments_invalid"}, sort_keys=True))
        raise SystemExit(2)


def _fail(code: str) -> None:
    raise PreparationError(code)


def parse_smoke_flags(specifications: list[str]) -> dict[str, bool]:
    flags: dict[str, bool] = {}
    for specification in specifications:
        name, separator, raw_value = specification.partition("=")
        if not separator or name not in ALLOWED_SMOKE_FLAGS:
            _fail("smoke_flag_not_allowlisted")
        if raw_value not in {"true", "false"}:
            _fail("smoke_flag_must_be_boolean")
        if name in flags:
            _fail("duplicate_smoke_flag")
        flags[name] = raw_value == "true"
    if not flags:
        _fail("at_least_one_smoke_flag_required")
    return flags


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _resolve_product_path(raw_path: Any, product_root: Path, test_host: Path | None = None) -> Path:
    if not isinstance(raw_path, str) or not raw_path or len(raw_path) > 4096:
        _fail("product_path_invalid")

    if raw_path.startswith("__TESTROOT__/"):
        base = product_root
        relative = raw_path.removeprefix("__TESTROOT__/")
    elif raw_path.startswith("__TESTHOST__/"):
        if test_host is None:
            _fail("test_host_required_for_macro")
        base = test_host
        relative = raw_path.removeprefix("__TESTHOST__/")
    elif "__TESTROOT__" in raw_path or "__TESTHOST__" in raw_path or "__" in raw_path:
        _fail("product_path_macro_unsupported")
    else:
        candidate = Path(raw_path)
        if not candidate.is_absolute():
            candidate = product_root / candidate
        resolved = candidate.resolve(strict=True)
        if not _is_relative_to(resolved, product_root):
            _fail("product_path_escapes_root")
        return resolved

    relative_path = Path(relative)
    if relative_path.is_absolute() or any(part in {"..", ""} for part in relative_path.parts):
        _fail("product_path_traversal_rejected")
    resolved = (base / relative_path).resolve(strict=True)
    if not _is_relative_to(resolved, product_root):
        _fail("product_path_escapes_root")
    return resolved


def _read_plist(path: Path) -> dict[str, Any]:
    try:
        parsed = plistlib.loads(path.read_bytes())
    except (OSError, plistlib.InvalidFileException, ValueError):
        _fail("plist_invalid")
    if not isinstance(parsed, dict):
        _fail("plist_root_invalid")
    return parsed


def _find_target_configuration(document: dict[str, Any]) -> dict[str, Any]:
    candidates = [
        value
        for value in document.values()
        if isinstance(value, dict)
        and {"TestHostPath", "TestBundlePath", "DependentProductPaths"}.issubset(value)
    ]
    if len(candidates) != 1:
        _fail("single_test_configuration_required")
    return candidates[0]


def _validate_no_aut_fields(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in FORBIDDEN_AUT_FIELDS:
                _fail("aut_configuration_field_present")
            if key == "UseDestinationArtifacts" and child is True:
                _fail("physical_destination_configuration_rejected")
            if key == "UITargetAppLaunchArguments" and child:
                _fail("aut_environment_or_arguments_present")
            _validate_no_aut_fields(child)
    elif isinstance(value, list):
        for child in value:
            _validate_no_aut_fields(child)


def _sensitive_environment_key(key: str) -> bool:
    normalized = re.sub(r"[^A-Z0-9]", "", key.upper())
    return any(fragment in normalized for fragment in SENSITIVE_ENV_PARTS)


def _validate_environment_maps(
    document: dict[str, Any],
    selected_configuration: dict[str, Any],
    selected_flags: dict[str, bool],
    source: Path,
    product_root: Path,
    test_host: Path,
) -> None:
    filename_scheme = source.name.split("_iphonesimulator", 1)[0]
    if (
        filename_scheme != RUNNER_ONLY_SCHEME
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", filename_scheme)
    ):
        _fail("runner_only_scheme_mismatch")

    def validate_target_sdk_map(environment: dict[str, str]) -> None:
        for env_key in environment:
            if _sensitive_environment_key(env_key):
                _fail("credential_like_environment_key_rejected")
            if env_key not in SDK_TARGET_APP_ENVIRONMENT_KEYS:
                _fail("target_app_environment_key_not_allowlisted")
        if environment and set(environment) != SDK_TARGET_APP_ENVIRONMENT_KEYS:
            _fail("target_app_environment_sdk_keyset_invalid")
        for env_key, env_value in environment.items():
            if not isinstance(env_value, str) or len(env_value) > 4096:
                _fail("target_app_environment_value_invalid")
            if any(ord(character) < 0x20 or ord(character) == 0x7F for character in env_value):
                _fail("target_app_environment_value_invalid")

            if env_key == "APP_DISTRIBUTOR_ID_OVERRIDE":
                if not APP_DISTRIBUTOR_ID_PATTERN.fullmatch(env_value):
                    _fail("target_app_distributor_invalid")
            elif env_key == "XCODE_SCHEME_NAME":
                if env_value != filename_scheme:
                    _fail("runner_only_scheme_mismatch")
            elif env_key in SDK_TARGET_APP_PATH_KEYS:
                if (
                    ":" in env_value
                    or "\\" in env_value
                    or not env_value.startswith("__TESTROOT__/")
                ):
                    _fail("target_app_sdk_path_invalid")
                relative = Path(env_value.removeprefix("__TESTROOT__/"))
                if (
                    relative.is_absolute()
                    or any(part in {"", ".", ".."} for part in relative.parts)
                    or any(part.lower().endswith(".app") for part in relative.parts)
                ):
                    _fail("target_app_sdk_path_invalid")
                resolved = _resolve_product_path(env_value, product_root)
                if not resolved.is_dir():
                    _fail("target_app_sdk_path_invalid")

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key in ENVIRONMENT_FIELDS:
                    if not isinstance(child, dict) or any(
                        not isinstance(env_key, str) or not isinstance(env_value, str)
                        for env_key, env_value in child.items()
                    ):
                        _fail("environment_map_invalid")
                    if key == "UITargetAppEnvironmentVariables":
                        if value is not selected_configuration:
                            if child:
                                _fail("target_app_environment_not_selected_configuration")
                        else:
                            validate_target_sdk_map(child)
                    for env_key in child:
                        if _sensitive_environment_key(env_key):
                            _fail("credential_like_environment_key_rejected")
                        if env_key.startswith("HUSHH_"):
                            if (
                                value is not selected_configuration
                                or key != "EnvironmentVariables"
                                or env_key not in ALLOWED_SMOKE_FLAGS
                            ):
                                _fail("unapproved_hushh_environment_key")
                            if env_key not in selected_flags:
                                _fail("smoke_flag_must_be_explicit")
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(document)


def _bundle_identifier(bundle: Path) -> str:
    info = bundle / "Info.plist"
    resolved_info = info.resolve(strict=True)
    if not _is_relative_to(resolved_info, bundle):
        _fail("bundle_info_path_escapes_bundle")
    metadata = _read_plist(resolved_info)
    identifier = metadata.get("CFBundleIdentifier")
    if not isinstance(identifier, str) or not identifier or len(identifier) > 255:
        _fail("bundle_identifier_missing")
    return identifier


def _validate_runner_products(configuration: dict[str, Any], product_root: Path) -> tuple[Path, Path, str, str]:
    if configuration.get("UseUITargetAppProvidedByTests") is not True:
        _fail("test_target_application_not_none")
    _validate_no_aut_fields(configuration)

    host = _resolve_product_path(configuration.get("TestHostPath"), product_root)
    if not host.is_dir() or host.suffix != ".app":
        _fail("test_host_product_invalid")
    host_bundle_id = _bundle_identifier(host)
    declared_host_id = configuration.get("TestHostBundleIdentifier")
    if not isinstance(declared_host_id, str) or declared_host_id != host_bundle_id:
        _fail("test_host_bundle_identity_mismatch")
    if not host_bundle_id.endswith(".uitests.xctrunner"):
        _fail("test_host_is_not_ui_test_runner")

    test_bundle = _resolve_product_path(configuration.get("TestBundlePath"), product_root, host)
    if not test_bundle.is_dir() or test_bundle.suffix != ".xctest":
        _fail("test_bundle_product_invalid")
    relative_bundle = test_bundle.relative_to(host)
    if len(relative_bundle.parts) != 2 or relative_bundle.parts[0] != "PlugIns":
        _fail("test_bundle_not_nested_in_runner")
    test_bundle_id = _bundle_identifier(test_bundle)
    declared_test_bundle_id = configuration.get("TestBundleIdentifier")
    if declared_test_bundle_id is not None and declared_test_bundle_id != test_bundle_id:
        _fail("test_bundle_identity_mismatch")
    if not test_bundle_id.endswith(".uitests"):
        _fail("test_bundle_identity_invalid")

    destination = configuration.get("TestBundleDestinationRelativePath")
    if destination is not None:
        destination_path = _resolve_product_path(destination, product_root, host)
        if destination_path != test_bundle:
            _fail("test_bundle_destination_mismatch")

    raw_products = configuration.get("DependentProductPaths")
    if not isinstance(raw_products, list) or len(raw_products) != 2:
        _fail("runner_only_dependent_products_required")
    products = [_resolve_product_path(item, product_root, host) for item in raw_products]
    if len(set(products)) != 2 or set(products) != {host, test_bundle}:
        _fail("runner_only_dependent_products_required")

    app_products = product_root.rglob("*.app")
    if any(path.is_symlink() or path.resolve(strict=True) != host for path in app_products):
        _fail("application_product_present")

    return host, test_bundle, host_bundle_id, test_bundle_id


def _serialize(document: dict[str, Any], source_bytes: bytes) -> bytes:
    format_kind = plistlib.FMT_BINARY if source_bytes.startswith(b"bplist00") else plistlib.FMT_XML
    return plistlib.dumps(document, fmt=format_kind, sort_keys=True)


def _read_existing_regular_output(path: Path) -> bytes:
    no_follow = getattr(os, "O_NOFOLLOW", None)
    if no_follow is None:
        _fail("output_conflict")
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            _fail("output_conflict")
        descriptor = os.open(path, os.O_RDONLY | no_follow)
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_nlink != 1
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
            ):
                _fail("output_conflict")
            with os.fdopen(descriptor, "rb") as stream:
                descriptor = -1
                content = stream.read()
            after = path.lstat()
            if (
                not stat.S_ISREG(after.st_mode)
                or after.st_nlink != 1
                or (after.st_dev, after.st_ino) != (opened.st_dev, opened.st_ino)
            ):
                _fail("output_conflict")
            return content
        finally:
            if descriptor >= 0:
                os.close(descriptor)
    except PreparationError:
        raise
    except OSError:
        _fail("output_conflict")


def _atomic_create_identical_or_fail(path: Path, content: bytes) -> str:
    if path.is_symlink():
        _fail("output_symlink_rejected")
    if path.exists():
        existing = _read_existing_regular_output(path)
        if existing == content:
            return "existing_identical"
        _fail("output_conflict")

    descriptor, temporary_name = tempfile.mkstemp(prefix=".local-session-xctestrun-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            existing = _read_existing_regular_output(path)
            if existing == content:
                return "existing_identical"
            _fail("output_conflict")
        return "created"
    except OSError:
        _fail("output_write_failed")
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def prepare_xctestrun(source: Path, smoke_flags: dict[str, bool]) -> dict[str, Any]:
    if not smoke_flags or any(name not in ALLOWED_SMOKE_FLAGS or not isinstance(value, bool) for name, value in smoke_flags.items()):
        _fail("smoke_flags_invalid")
    if source.is_symlink():
        _fail("source_symlink_rejected")
    try:
        source = source.resolve(strict=True)
        if not source.is_file() or source.suffix != ".xctestrun":
            _fail("source_xctestrun_invalid")
        source_bytes = source.read_bytes()
        document = plistlib.loads(source_bytes)
    except PreparationError:
        raise
    except (OSError, plistlib.InvalidFileException, ValueError):
        _fail("source_xctestrun_invalid")
    if not isinstance(document, dict):
        _fail("xctestrun_root_invalid")

    configuration = _find_target_configuration(document)
    _validate_no_aut_fields(document)
    product_root = source.parent.resolve(strict=True)
    host, _, _, _ = _validate_runner_products(configuration, product_root)
    _validate_environment_maps(document, configuration, smoke_flags, source, product_root, host)

    updated = copy.deepcopy(document)
    updated_configuration = _find_target_configuration(updated)
    updated_configuration["SystemAttachmentLifetime"] = "keepNever"
    updated_configuration["UserAttachmentLifetime"] = "keepNever"
    environment = updated_configuration.setdefault("EnvironmentVariables", {})
    if not isinstance(environment, dict):
        _fail("environment_map_invalid")
    for name, enabled in smoke_flags.items():
        environment[name] = "true" if enabled else "false"

    output_bytes = _serialize(updated, source_bytes)
    source_digest = hashlib.sha256(source_bytes).hexdigest()
    flags_digest = hashlib.sha256(
        json.dumps(smoke_flags, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:12]
    output = source.with_name(f"local-session-{source_digest[:12]}-{flags_digest}{source.suffix}")
    disposition = _atomic_create_identical_or_fail(output, output_bytes)
    return {
        "ok": True,
        "disposition": disposition,
        "output_name": output.name,
        "source_sha256": source_digest,
        "output_sha256": hashlib.sha256(output_bytes).hexdigest(),
        "smoke_flags": smoke_flags,
        "attachment_lifetimes": {
            "SystemAttachmentLifetime": "keepNever",
            "UserAttachmentLifetime": "keepNever",
        },
        "dependent_product_count": 2,
        "aut_target_path_present": False,
    }


def main() -> int:
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument("xctestrun", type=Path, help="Xcode-generated runner-only simulator xctestrun")
    parser.add_argument(
        "--smoke-flag",
        action="append",
        default=[],
        metavar="NAME=true|false",
        help="Set one allowlisted boolean test opt-in; repeat only for explicit smoke flags",
    )
    args = parser.parse_args()
    try:
        flags = parse_smoke_flags(args.smoke_flag)
        receipt = prepare_xctestrun(args.xctestrun, flags)
    except PreparationError as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True))
        return 2
    except Exception:
        print(json.dumps({"ok": False, "error": "preparation_failed"}, sort_keys=True))
        return 2
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
