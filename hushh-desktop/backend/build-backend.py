import os
import sys
import PyInstaller.__main__

def build():
    # Base directory is where this script resides
    base_dir = os.path.dirname(os.path.abspath(__file__))
    server_script = os.path.join(base_dir, "server.py")
    
    # Common hidden imports for FastAPI, Uvicorn, and SQLAlchemy
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
        "pydantic",
        "sqlalchemy",
        "sqlalchemy.ext.asyncio",
        "asyncpg",
        "psycopg2",
        "cryptography",
    ]
    
    # PyInstaller Arguments
    args = [
        server_script,
        "--name=hushh-backend",
        "--onefile",
        "--clean",
        "--noconfirm",
        "--distpath=" + os.path.join(base_dir, "dist"),
        "--workpath=" + os.path.join(base_dir, "build"),
    ]
    
    # Add hidden imports
    for imp in hidden_imports:
        args.extend(["--hidden-import", imp])
        
    print(f"Building hushh-backend with PyInstaller args: {args}")
    PyInstaller.__main__.run(args)

if __name__ == "__main__":
    build()
