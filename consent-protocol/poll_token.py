import urllib.request
import urllib.parse
import json
import time
import subprocess
import sys
import os

CLIENT_ID = "178c6fc778ccc68e1d6a"
DEVICE_CODE = "3b47a2c51ae5960a3d3d808cb4b1cf5731659ff6"

token_url = "https://github.com/login/oauth/access_token"
token_data = urllib.parse.urlencode({
    "client_id": CLIENT_ID,
    "device_code": DEVICE_CODE,
    "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
}).encode("utf-8")

interval = 5
token = None

for _ in range(60):  # poll for 5 minutes
    try:
        req = urllib.request.Request(token_url, data=token_data, headers={"Accept": "application/json"})
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
    except Exception as e:
        print("Polling error:", e)
        time.sleep(interval)

if token:
    print("Got token! Configuring gh...")
    p = subprocess.Popen(["gh", "auth", "login", "--with-token"], stdin=subprocess.PIPE)
    p.communicate(input=token.encode("utf-8"))
    
    print("Pushing branch...")
    subprocess.run(["git", "push", "-u", "origin", "feat/add-token-validation-helpers"])
    print("Push complete.")
else:
    print("Did not get token in time.")
