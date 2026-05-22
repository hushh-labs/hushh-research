import os
import re

api_dir = "/Users/pranaovs/Documents/hushh/hushh-research/hushh-webapp/app/api"

patterns = [
    r"const BACKEND_URL = getPythonApiUrl\(\);",
    r"const PYTHON_API_URL = getPythonApiUrl\(\);",
    r"const BACKEND_URL = getDeveloperApiUrl\(\);"
]

for root, dirs, files in os.walk(api_dir):
    for file in files:
        if file == "route.ts":
            path = os.path.join(root, file)
            with open(path, "r") as f:
                content = f.read()
            
            modified = False
            for pattern in patterns:
                if re.search(pattern, content):
                    # Replace top-level declaration with a comment
                    new_content = re.sub(pattern, f"// MOVED INSIDE HANDLER: {pattern}", content)
                    
                    # Insert inside handlers
                    # Match: export async function GET(request: NextRequest, ...
                    # We look for the first '{' after the function signature
                    
                    def replacer(match):
                        func_name = match.group(1)
                        # Find the first '{' after this match
                        rest = content[match.end():]
                        brace_index = rest.find('{')
                        if brace_index != -1:
                            # We can't easily use sub with match objects for this complex logic
                            return match.group(0)
                        return match.group(0)

                    # Simpler approach: find all exported handler starts
                    handler_pattern = r"(export async function (GET|POST|PUT|DELETE|PATCH|OPTIONS)\s*\([^)]*\)\s*\{)"
                    
                    # Pre-calculate what to insert
                    var_name = "BACKEND_URL" if "BACKEND_URL" in pattern else "PYTHON_API_URL"
                    func_call = "getPythonApiUrl()" if "getPythonApiUrl" in pattern else "getDeveloperApiUrl()"
                    insertion = f"\n  const {var_name} = {func_call};"
                    
                    # We use a lambda to avoid inserting multiple times if multiple patterns match (rare)
                    new_content = re.sub(handler_pattern, r"\1" + insertion, new_content)
                    
                    if new_content != content:
                        content = new_content
                        modified = True
            
            if modified:
                with open(path, "w") as f:
                    f.write(content)
                print(f"Refactored {path}")
