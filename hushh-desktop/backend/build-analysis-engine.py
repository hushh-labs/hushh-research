import os

import PyInstaller.__main__


def build():
    # Base directory is where this script resides
    base_dir = os.path.dirname(os.path.abspath(__file__))
    server_script = os.path.join(base_dir, "local_analysis_engine", "server.py")

    # Same minimal profile as build-local-bridge.py -- no DB/vault deps here
    # either, plus the mcp package's own streamable-http/starlette stack.
    hidden_imports = [
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "uvicorn.lifespan.off",
        "starlette",
        "mcp.server.fastmcp",
        "mcp.server.streamable_http",
    ]

    args = [
        server_script,
        "--name=hushh-analysis-engine",
        "--onefile",
        "--clean",
        "--noconfirm",
        "--distpath=" + os.path.join(base_dir, "dist"),
        "--workpath=" + os.path.join(base_dir, "build"),
    ]

    for imp in hidden_imports:
        args.extend(["--hidden-import", imp])

    print(f"Building hushh-analysis-engine with PyInstaller args: {args}")
    PyInstaller.__main__.run(args)


if __name__ == "__main__":
    build()
