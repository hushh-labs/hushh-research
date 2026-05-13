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
            
            # Pattern 1: Match the comment and restore the variable
            pattern = r"// MOVED INSIDE HANDLER: (const (PYTHON_API_URL|BACKEND_URL) = (getPythonApiUrl|getDeveloperApiUrl)\([^)]*\);?)"
            match = re.search(pattern, content)
            if match:
                # Remove any existing (incorrectly escaped) comment and the local declarations
                # and restore the global one
                decl = match.group(1).replace('\\(', '(').replace('\\)', ')')
                content = re.sub(pattern, decl, content)
                modified = True

            # Pattern 2: If PYTHON_API_URL or BACKEND_URL is used but not defined at module level
            # (In case Pattern 1 didn't catch it because the comment was different)
            for var in ["PYTHON_API_URL", "BACKEND_URL"]:
                if var in content and f"const {var} =" not in content:
                    helper = "getPythonApiUrl()" if var == "PYTHON_API_URL" or "BACKEND_URL" in content else "getDeveloperApiUrl()"
                    # Prepend after the last import
                    lines = content.split('\n')
                    last_import_idx = -1
                    for i, line in enumerate(lines):
                        if line.startswith("import "):
                            last_import_idx = i
                    
                    if last_import_idx != -1:
                        lines.insert(last_import_idx + 1, f"\nconst {var} = {helper};")
                        content = '\n'.join(lines)
                        modified = True
            
            if modified:
                with open(path, "w") as f:
                    f.write(content)
                print(f"Fixed {path}")
