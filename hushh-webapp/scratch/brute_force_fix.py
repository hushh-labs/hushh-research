import os
import re

api_dir = "/Users/pranaovs/Documents/hushh/hushh-research/hushh-webapp/app/api"

for root, dirs, files in os.walk(api_dir):
    for file in files:
        if file == "route.ts":
            path = os.path.join(root, file)
            with open(path, "r") as f:
                content = f.read()
            
            modified = False
            
            # 1. Restore global variables based on what's used in the file
            if "PYTHON_API_URL" in content and "const PYTHON_API_URL =" not in content:
                 content = "const PYTHON_API_URL = getPythonApiUrl();\n" + content
                 modified = True
            
            if "BACKEND_URL" in content and "const BACKEND_URL =" not in content:
                 content = "const BACKEND_URL = getPythonApiUrl();\n" + content
                 modified = True

            # 2. Ensure imports are present if variables are used
            if ("PYTHON_API_URL" in content or "BACKEND_URL" in content) and "getPythonApiUrl" not in content:
                # This check is a bit flawed since it might match the string getPythonApiUrl in the variable declaration I just added.
                # So let's check for the actual import line.
                pass

            if ("PYTHON_API_URL" in content or "BACKEND_URL" in content) and 'from "@/app/api/_utils/backend"' not in content:
                 content = 'import { getPythonApiUrl } from "@/app/api/_utils/backend";\n' + content
                 modified = True

            if modified:
                with open(path, "w") as f:
                    f.write(content)
                print(f"Brute-force fixed with import {path}")
