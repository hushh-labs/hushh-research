import urllib.request
import urllib.parse
import json
import time
import subprocess
import sys

CLIENT_ID = "178c6fc778ccc68e1d6a"  # GitHub CLI client ID

def main():
    # 1. Request device code
    req = urllib.request.Request(
        "https://github.com/login/device/code",
        data=urllib.parse.urlencode({"client_id": CLIENT_ID, "scope": "repo read:org"}).encode("utf-8"),
        headers={"Accept": "application/json", "User-Agent": "Hushh-Consent-Protocol/1.0"}
    )
    
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read())
        
    device_code = data["device_code"]
    user_code = data["user_code"]
    verification_uri = data["verification_uri"]
    interval = data["interval"]
    
    print(f"SUCCESS_CODE:{user_code}")
    print(f"Please open {verification_uri} and enter the code.")
    
    # 2. Poll for token
    token_url = "https://github.com/login/oauth/access_token"
    token_data = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "device_code": device_code,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
    }).encode("utf-8")
    
    token = None
    while True:
        req = urllib.request.Request(token_url, data=token_data, headers={"Accept": "application/json", "User-Agent": "Hushh-Consent-Protocol/1.0"})
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read())
            
        if "access_token" in result:
            token = result["access_token"]
            break
        elif result.get("error") == "authorization_pending":
            time.sleep(interval)
        elif result.get("error") == "slow_down":
            interval += 5
            time.sleep(interval)
        else:
            print("Error:", result)
            sys.exit(1)
            
    print("Authentication successful! Configuring gh CLI...")
    
    # 3. Configure gh cli
    p = subprocess.Popen(["gh", "auth", "login", "--with-token"], stdin=subprocess.PIPE)
    p.communicate(input=token.encode("utf-8"))
    
    if p.returncode == 0:
        print("gh CLI successfully configured!")
    else:
        print("Failed to configure gh CLI")

if __name__ == "__main__":
    main()
