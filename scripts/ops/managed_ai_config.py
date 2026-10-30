#!/usr/bin/env python3
"""Compile deploy metadata from the same packaged profile that constructs clients."""

import argparse
import importlib.util
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", required=True)
    parser.add_argument(
        "--format",
        choices=("json", "substitutions", "hash", "provider", "validate", "azure-account"),
        default="json",
    )
    args = parser.parse_args()
    path = (
        Path(__file__).resolve().parents[2]
        / "consent-protocol/config/managed-ai-runtime.json"
    )
    spec = importlib.util.spec_from_file_location(
        "managed_ai_contract", path.parent.parent / "hushh_mcp/managed_ai_config.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    value = module.load_profile(args.environment, path)
    if args.format == "validate":
        print(json.dumps(module.validate_runtime_config(path), sort_keys=True))
        return
    if args.format == "provider":
        print(module.configured_managed_provider(args.environment, path))
        return
    if args.format == "azure-account":
        if args.environment != "uat":
            parser.error("Only UAT selects a managed Azure account")
        print(json.dumps(module.managed_azure_inventory(path), indent=2, sort_keys=True))
        return
    if args.format == "hash":
        print(module.profile_hash(value))
    elif args.format == "substitutions":
        fields = {
            "_MANAGED_AI_CONFIG_HASH": module.profile_hash(value),
            "_GENAI_PROJECT_ID": value["project"],
            "_HUSSH_GEMINI_TEXT_MODEL": value["text_model"],
            "_VERTEX_LIVE_MODEL_ID": value["live_model"],
            "_VERTEX_LIVE_LOCATION": value["live_location"],
        }
        print("##".join(f"{key}={item}" for key, item in fields.items()))
    else:
        print(json.dumps(value))


if __name__ == "__main__":
    main()
