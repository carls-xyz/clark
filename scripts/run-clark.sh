#!/bin/bash
# Lance Clark pour launchd (agent local.clark). Ne pas lancer à la main : utilise scripts/service.sh.
# « exec -a clark-agent » : le processus s'appelle clark-agent, pas node, pour que le script
# « orphelins dev » de l'optimisation du Mac ne le prenne pas pour un serveur oublié.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p data/logs
# Journal tournant : au-delà de 5 Mo, l'ancien part en .1 (un seul gardé).
log=data/logs/clark.log
if [ -f "$log" ] && [ "$(stat -f%z "$log")" -gt 5242880 ]; then mv -f "$log" "$log.1"; fi
exec -a clark-agent "$(command -v node)" src/index.ts >>"$log" 2>&1
