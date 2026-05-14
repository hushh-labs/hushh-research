#!/usr/bin/env python3
import json
import os
import sys
import logging
from pathlib import Path

# Setup logging for better traceability
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger("hushh-setup")

def get_claude_config_path() -> Path:
    """Get the Claude Desktop configuration file path for the current OS."""
    home = Path.home()
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "Claude" / "claude_desktop_config.json"
    elif sys.platform == "darwin":  # macOS
        return home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    
    # Default/Linux
    return home / ".config" / "Claude" / "claude_desktop_config.json"

def generate_config() -> dict:
    """Generate the MCP server configuration with absolute paths."""
    # This script is in the root, so consent-protocol is a subdirectory
    root_dir = Path(__file__).parent.resolve()
    consent_dir = root_dir / "consent-protocol"
    mcp_server_path = consent_dir / "mcp_server.py"

    if not mcp_server_path.exists():
        raise FileNotFoundError(f"MCP server not found at: {mcp_server_path}")

    # Use sys.executable to ensure we use the same python interpreter
    return {
        "mcpServers": {
            "hushh-consent": {
                "command": sys.executable,
                "args": [str(mcp_server_path)],
                "env": {"PYTHONPATH": str(consent_dir)},
            }
        }
    }

def install_config(config: dict) -> bool:
    """Safer config installation with backup logic."""
    try:
        config_path = get_claude_config_path()
        config_path.parent.mkdir(parents=True, exist_ok=True)

        existing_config = {}
        if config_path.exists():
            # Backup existing config before modification
            backup_path = config_path.with_suffix(".json.bak")
            with open(config_path, "r", encoding="utf-8") as f:
                try:
                    existing_config = json.load(f)
                    with open(backup_path, "w", encoding="utf-8") as backup:
                        json.dump(existing_config, backup, indent=2)
                    logger.info(f"Created backup at: {backup_path}")
                except json.JSONDecodeError:
                    logger.warning("Existing config corrupted, starting fresh.")

        if "mcpServers" not in existing_config:
            existing_config["mcpServers"] = {}

        existing_config["mcpServers"].update(config["mcpServers"])

        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(existing_config, f, indent=2)
        return True
    except Exception as e:
        logger.error(f"Installation failed: {e}")
        return False

def main():
    logger.info("=" * 60)
    logger.info("🔐 Hushh MCP Server - Configuration Generator")
    logger.info("=" * 60)
    
    try:
        config = generate_config()
        logger.info("✅ Configuration generated successfully!")
        
        print("\n📋 Generated Configuration:")
        print("-" * 40)
        print(json.dumps(config, indent=2))
        print("-" * 40)
        
        # In CI environment, we skip interactive input
        if os.environ.get("CI") == "true":
            logger.info("CI environment detected, skipping installation.")
            return

        response = input("\nInstall to Claude Desktop? (y/n): ").strip().lower()
        if response == "y":
            if install_config(config):
                logger.info("✅ Configuration installed successfully!")
                print("\n🔄 Next steps:")
                print("   1. Fully quit Claude Desktop (check system tray)")
                print("   2. Reopen Claude Desktop")
                print("   3. Look for 🔧 tool icon")
                print("   4. Ask: 'What Hushh tools do you have?'")
        else:
            print("\n📋 Manual installation required.")
            
    except Exception as e:
        logger.error(f"Setup failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
