#!/usr/bin/env python3
"""
Hussh MCP Server - Configuration Generator

Automatically generates the Claude Desktop configuration file
with correct paths for the current system.

Usage:
    python setup_mcp.py

This will:
1. Detect the consent-protocol directory location
2. Generate the correct claude_desktop_config.json
3. Optionally copy it to the Claude Desktop config location
"""

import json
import os
import sys
from pathlib import Path


def get_claude_config_path() -> Path:
    """Get the Claude Desktop configuration file path for the current OS."""
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "Claude" / "claude_desktop_config.json"
    elif sys.platform == "darwin":  # macOS
        return (
            Path.home()
            / "Library"
            / "Application Support"
            / "Claude"
            / "claude_desktop_config.json"
        )
    else:  # Linux
        return Path.home() / ".config" / "Claude" / "claude_desktop_config.json"

    raise RuntimeError("Could not determine Claude Desktop config path")


def get_consent_protocol_dir() -> Path:
    """Get the absolute path to the consent-protocol directory."""
    # This script is in consent-protocol/, so parent is the dir itself
    return Path(__file__).parent.resolve()


def generate_config() -> dict:
    """Generate the MCP server configuration."""
    consent_dir = get_consent_protocol_dir()
    mcp_server_path = consent_dir / "mcp_server.py"

    if not mcp_server_path.exists():
        raise FileNotFoundError(f"MCP server not found at: {mcp_server_path}")

    config = {
        "mcpServers": {
            "hushh-consent": {
                "command": "python",
                "args": [str(mcp_server_path)],
                "env": {"PYTHONPATH": str(consent_dir)},
            }
        }
    }

    return config


def save_example_config(config: dict, consent_dir: Path) -> Path:
    """Save the generated config as an example file in the repo."""
    example_path = consent_dir / "claude_desktop_config.generated.json"
    with open(example_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    return example_path


def install_config(config: dict) -> bool:
    """Install the config to Claude Desktop's config location."""
    try:
        config_path = get_claude_config_path()

        # Create directory if it doesn't exist
        config_path.parent.mkdir(parents=True, exist_ok=True)

        # Check if config already exists
        existing_config = {}
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                try:
                    existing_config = json.load(f)
                except json.JSONDecodeError:
                    existing_config = {}

        # Merge configs (add our server to existing)
        if "mcpServers" not in existing_config:
            existing_config["mcpServers"] = {}

        existing_config["mcpServers"]["hushh-consent"] = config["mcpServers"]["hushh-consent"]

        # Write merged config
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(existing_config, f, indent=2)

        return True
    except Exception as e:
        print(f"❌ Could not install config: {e}")
        return False


def main():
    print("=" * 60)
    print("🔐 Hussh MCP Server - Configuration Generator")
    print("=" * 60)
    print()

    # Get consent-protocol directory
    consent_dir = get_consent_protocol_dir()
    print("📁 Consent Protocol Directory:")
    print(f"   {consent_dir}")
    print()

    # Generate config
    try:
        config = generate_config()
        print("✅ Configuration generated successfully!")
        print()
    except FileNotFoundError as e:
        print(f"❌ Error: {e}")
        sys.exit(1)

    # Show the generated config
    print("📋 Generated Configuration:")
    print("-" * 40)
    print(json.dumps(config, indent=2))
    print("-" * 40)
    print()

    # Save example config
    example_path = save_example_config(config, consent_dir)
    print(f"💾 Saved to: {example_path}")
    print()

    # Ask to install
    claude_config_path = get_claude_config_path()
    print("📍 Claude Desktop config location:")
    print(f"   {claude_config_path}")
    print()

    response = input("Install to Claude Desktop? (y/n): ").strip().lower()
    if response == "y":
        if install_config(config):
            print()
            print("✅ Configuration installed successfully!")
            print()
            print("🔄 Next steps:")
            print("   1. Fully quit Claude Desktop (check system tray)")
            print("   2. Reopen Claude Desktop")
            print("   3. Look for 🔧 tool icon")
            print("   4. Ask: 'What Hussh tools do you have?'")
        else:
            print()
            print("⚠️  Could not auto-install. Please copy manually:")
            print(f"   From: {example_path}")
            print(f"   To:   {claude_config_path}")
    else:
        print()
        print("📋 Manual installation:")
        print("   Copy the contents of:")
        print(f"   {example_path}")
        print("   To:")
        print(f"   {claude_config_path}")

    print()
    print("=" * 60)


if __name__ == "__main__":
    main()
