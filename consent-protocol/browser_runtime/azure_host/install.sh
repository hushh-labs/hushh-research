#!/bin/bash
# Root-owned bundle installed by the admitted Azure setup operation. No owner secrets.
set -euo pipefail
umask 077
cd /opt/hussh-host
test "$(id -u)" = 0
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends docker.io=29.1.3-0ubuntu3~24.04.2 apparmor-utils certbot openssl
chown -R root:root /opt/hussh-host
chmod 0755 /opt/hussh-host
chmod 0644 ./azure_host/*.py ./seccomp.json ./apparmor.profile
chmod 0600 installation.json
python3 -E -s -c 'import azure_host.runner'
install -m 0644 hussh-owner-pod.service /etc/systemd/system/hussh-owner-pod.service
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/hussh-owner-pod <<'HOOK'
#!/bin/sh
cd /opt/hussh-host
exec /usr/bin/python3 -E -s -m azure_host.tls
HOOK
chmod 0700 /etc/letsencrypt/renewal-hooks/deploy/hussh-owner-pod
# Timer executes only on a running VM; it never starts/deallocates a cloud VM.
systemctl enable --now certbot.timer
systemctl daemon-reload
systemctl enable --now hussh-owner-pod.service
