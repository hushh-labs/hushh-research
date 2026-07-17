import os

import PyInstaller.__main__


def build():
    # Base directory is where this script resides
    base_dir = os.path.dirname(os.path.abspath(__file__))
    server_script = os.path.join(base_dir, "local_bridge", "server.py")

    # local_bridge only needs fastapi/uvicorn/aiohttp -- deliberately not the
    # full hidden-import list build-backend.py needs (sqlalchemy, asyncpg,
    # etc.), since local_bridge has no DB/vault dependency at all.
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
        "fastapi",
    ]

    args = [
        server_script,
        "--name=hushh-local-bridge",
        "--onefile",
        "--clean",
        "--noconfirm",
        "--distpath=" + os.path.join(base_dir, "dist"),
        "--workpath=" + os.path.join(base_dir, "build"),
    ]

    for imp in hidden_imports:
        args.extend(["--hidden-import", imp])

    print(f"Building hushh-local-bridge with PyInstaller args: {args}")
    PyInstaller.__main__.run(args)


if __name__ == "__main__":
    build()
