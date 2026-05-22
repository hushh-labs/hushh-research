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
            
            # If PYTHON_API_URL is used but not defined at module level
            if "PYTHON_API_URL" in content and "const PYTHON_API_URL =" not in content:
                # Find the import line to insert after
                import_pattern = r'import { getPythonApiUrl } from "@/app/api/_utils/backend";'
                if import_pattern in content:
                    content = content.replace(import_pattern, import_pattern + "\n\nconst PYTHON_API_URL = getPythonApiUrl();")
                    modified = True

            # Same for BACKEND_URL
            if "BACKEND_URL" in content and "const BACKEND_URL =" not in content:
                 import_pattern = r'import { getPythonApiUrl } from "@/app/api/_utils/backend";'
                 if import_pattern in content:
                    content = content.replace(import_pattern, import_pattern + "\n\nconst BACKEND_URL = getPythonApiUrl();")
                    modified = True

            if modified:
                with open(path, "w") as f:
                    f.write(content)
                print(f"Restored {path}")
