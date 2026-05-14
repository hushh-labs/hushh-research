import pexpect
import sys
import re
import subprocess

def main():
    print("Starting GitHub Auth...")
    # Add path to gh
    child = pexpect.spawn('gh auth login -w -p https -h github.com', encoding='utf-8')
    child.logfile = sys.stdout
    
    # Authenticate Git with your GitHub credentials? (Y/n)
    index = child.expect(['Authenticate Git with your GitHub credentials', pexpect.EOF, pexpect.TIMEOUT], timeout=10)
    if index == 0:
        child.sendline('y')
    else:
        print("Prompt not found")
        sys.exit(1)
        
    # First copy your one-time code: ABCD-EFGH
    index = child.expect(['First copy your one-time code: ([A-Z0-9-]+)', pexpect.EOF, pexpect.TIMEOUT], timeout=10)
    if index == 0:
        code = child.match.group(1)
        print(f"\n\n====>> SUCCESS_CODE: {code} <<====\n\n")
        
        # Wait for authentication to complete
        index = child.expect(['Authentication complete', pexpect.EOF, pexpect.TIMEOUT], timeout=300)
        if index == 0:
            print("Auth complete! Pushing...")
            subprocess.run(["git", "push", "-u", "origin", "feat/add-token-validation-helpers"])
            print("Creating PR...")
            subprocess.run(["gh", "pr", "create", "--title", "feat: Add token validation helpers", "--body", "Adds is_expired and is_active methods to HushhConsentToken for smart validation.", "--head", "feat/add-token-validation-helpers"])
        else:
            print("Auth did not complete.")
    else:
        print("Could not get code.")

if __name__ == "__main__":
    main()
