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
            
            # Pattern 1: The comment with escaped parens
            comment_pattern = r"// MOVED INSIDE HANDLER: (const (BACKEND|PYTHON)_URL = get(Python|Developer)ApiUrl\\\(\\\);)"
            if re.search(comment_pattern, content):
                # Restore global declaration (remove backslashes from parens)
                decl = re.search(comment_pattern, content).group(1).replace('\\(', '(').replace('\\)', ')')
                content = re.sub(comment_pattern, decl, content)
                modified = True

            # Pattern 2: The placeholder comment I used in some files
            simple_comment = r"// MOVED INSIDE HANDLER"
            if re.search(simple_comment, content) and "BACKEND_URL =" in content and "getPythonApiUrl" in content:
                # We need to be careful here. If we find it, let's just make sure it's clean.
                content = re.sub(simple_comment, "", content)
                modified = True

            # Remove inserted local declarations
            local_pattern = r"\n  const (BACKEND_URL|PYTHON_API_URL) = get(Python|Developer)ApiUrl\(\);"
            if re.search(local_pattern, content):
                content = re.sub(local_pattern, "", content)
                modified = True
            
            if modified:
                # Deduplicate any remaining duplicate declarations if any
                # This is a bit risky, but let's just write and see.
                with open(path, "w") as f:
                    f.write(content)
                print(f"Reverted {path}")
