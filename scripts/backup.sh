#!/bin/bash
# Sauvegardes à la main : scripts/backup.sh now | init | snapshots | drill  (voir scripts/backup.ts)
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/backup.ts "$@"
