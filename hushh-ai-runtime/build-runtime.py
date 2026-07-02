import os
import sys
import subprocess
import glob
from pathlib import Path

def get_site_packages_dir():
    # Attempt to locate the site-packages in the current .venv
    venv_path = Path(__file__).parent / ".venv"
    if not venv_path.exists():
        print("ERROR: .venv not found. Did you run `uv sync`?")
        sys.exit(1)
        
    lib_path = venv_path / "Lib" / "site-packages"
    if not lib_path.exists():
        print(f"ERROR: site-packages not found at {lib_path}")
        sys.exit(1)
        
    return lib_path

def build():
    print("🚀 Building hushh-ai-runtime...")
    
    site_packages = get_site_packages_dir()
    
    # 1. Locate all DLLs in onnxruntime and onnxruntime_genai
    onnxruntime_dir = site_packages / "onnxruntime"
    genai_dir = site_packages / "onnxruntime_genai"
    
    dll_paths = []
    
    if onnxruntime_dir.exists():
        dlls = glob.glob(str(onnxruntime_dir / "capi" / "*.dll"))
        dll_paths.extend(dlls)
    
    if genai_dir.exists():
        dlls = glob.glob(str(genai_dir / "*.dll"))
        dll_paths.extend(dlls)
        
    if not dll_paths:
        print("⚠️ WARNING: No ONNX DLLs found. The resulting executable will likely crash when trying to use QNN.")
        
    # 2. Construct PyInstaller command
    # We use a 1-dir build (--onedir) instead of --onefile so the DLLs load faster and don't unpack to temp
    # This also solves a lot of DLL search path issues on Windows ARM64
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        "--windowed", # Run silently without popping a console window
        "--name", "hushh-ai-runtime",
        "main.py"
    ]
    
    # Add all discovered DLLs
    for dll in dll_paths:
        print(f"📦 Bundling DLL: {os.path.basename(dll)}")
        # syntax: --add-binary "src;dest_folder_in_bundle"
        cmd.extend(["--add-binary", f"{dll};onnxruntime/capi"])
        # We also put them in the root just in case
        cmd.extend(["--add-binary", f"{dll};."])

    # Add uvicorn and fastapi hidden imports just in case
    cmd.extend([
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.protocols",
        "--hidden-import", "uvicorn.protocols.http",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.websockets",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.lifespan",
        "--hidden-import", "uvicorn.lifespan.on",
    ])

    print("Executing PyInstaller...")
    subprocess.run(cmd, check=True)
    
    print("✅ Build complete! Executable is in dist/hushh-ai-runtime/")

if __name__ == "__main__":
    build()
