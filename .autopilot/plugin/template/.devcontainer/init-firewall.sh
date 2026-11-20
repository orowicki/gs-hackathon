#!/usr/bin/env bash
# Default-deny egress. Allows the base domains plus .devcontainer/allowlist.txt.
set -euo pipefail
BASE=(
  api.anthropic.com statsig.anthropic.com sentry.io claude.ai console.anthropic.com platform.claude.com
  registry.npmjs.org pypi.org files.pythonhosted.org
  github.com api.github.com objects.githubusercontent.com raw.githubusercontent.com codeload.github.com
  ntfy.sh
)
EXTRA=()
if [[ -f /workspace/.devcontainer/allowlist.txt ]]; then
  mapfile -t EXTRA < <(sed -e 's/#.*//' -e 's/[[:space:]]//g' /workspace/.devcontainer/allowlist.txt | grep -v '^$' || true)
fi
iptables -F; iptables -X; ipset destroy allowed 2>/dev/null || true
ipset create allowed hash:net
missing=()
for d in "${BASE[@]}" "${EXTRA[@]}"; do
  ips=$(dig +short A "$d" | grep -E '^[0-9.]+$' || true)
  [[ -z "$ips" ]] && missing+=("$d")
  for ip in $ips; do ipset add -exist allowed "$ip"; done
done
for cidr in $(curl -s --max-time 10 https://api.github.com/meta | jq -r '(.git+.api+.web)[]' | grep -v ':' | aggregate -q); do
  ipset add -exist allowed "$cidr"
done
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT -p udp --sport 53 -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed dst -j ACCEPT
iptables -P INPUT DROP; iptables -P FORWARD DROP; iptables -P OUTPUT DROP
# IPv6: no allowlist, drop everything but loopback. Docker usually has no v6, but rootless
# Podman (pasta) does, and an IPv4-only firewall then leaks.
if command -v ip6tables >/dev/null; then
  ip6tables -F; ip6tables -X
  ip6tables -A OUTPUT -o lo -j ACCEPT; ip6tables -A INPUT -i lo -j ACCEPT
  ip6tables -P INPUT DROP; ip6tables -P FORWARD DROP; ip6tables -P OUTPUT DROP
fi
if curl -s --max-time 5 https://example.com >/dev/null || curl -6 -s --max-time 5 https://example.com >/dev/null; then echo "Firewall FAILED: example.com reachable"; exit 1; fi
((${#missing[@]})) && echo "Firewall WARNING: no A record for: ${missing[*]}"
echo "Firewall OK ($(ipset list allowed | grep -c '^[0-9]') entries)"
