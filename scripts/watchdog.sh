#!/bin/bash
# Surveillance locale : lancé toutes les 5 minutes (minuteur systemd sur Linux, agent launchd sur le Mac,
# installés par scripts/service.sh install). Si Clark ne répond plus deux fois de suite (figé, sans
# avoir planté), il est relancé. Un plantage, lui, est déjà relancé par le service.
#
# - Délai de grâce : rien pendant les 3 minutes qui suivent un démarrage (data/started-at, écrit par Clark).
# - Service arrêté exprès (scripts/service.sh uninstall, systemctl stop) : rien.
# - Une relance laisse une note (data/watchdog-restart.txt) que Clark annonce au démarrage.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAILS="data/watchdog-fails"
LOG="data/logs/watchdog.log"
GRACE="${CLARK_WATCHDOG_GRACE:-180}"
FAKE="${CLARK_SERVICE_FAKE:-}"
OS="$(uname -s)"
mkdir -p data/logs

PORT="$(grep -E '^CLARK_WEB_PORT=' .env 2>/dev/null | tail -n1 | cut -d= -f2 | tr -d ' "'\''' || true)"
PORT="${CLARK_WEB_PORT:-${PORT:-4310}}"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >> "$LOG"; }

# Le service doit tourner (sinon : arrêté exprès, ou déjà relancé par le service lui-même).
if [ -z "$FAKE" ]; then
  if [ "$OS" = "Darwin" ]; then
    launchctl print "gui/$(id -u)/local.clark" >/dev/null 2>&1 || exit 0
  else
    [ "$(systemctl --user is-active clark.service 2>/dev/null)" = "active" ] || exit 0
  fi
fi

restart_clark() {
  if [ -n "$FAKE" ]; then "$FAKE" restart
  elif [ "$OS" = "Darwin" ]; then launchctl kickstart -k "gui/$(id -u)/local.clark"
  else systemctl --user restart clark.service
  fi
}

# Filet de déploiement (auto-amélioration). Clark pose data/deploy-pending (commit de secours, cible, heure)
# avant de redémarrer sur une nouvelle version, et le retire dès qu'elle a confirmé son démarrage. Le
# service.sh lancé par Clark meurt avec lui au redémarrage : si la nouvelle version ne démarre pas, plante en
# boucle ou gèle, c'est ici — job à part — qu'on revient en arrière. Placé AVANT le délai de grâce : une
# version qui plante en boucle réécrit data/started-at à chaque essai et resterait sinon en grâce pour toujours.
PENDING="data/deploy-pending"
DEPLOY_GRACE="${CLARK_DEPLOY_GRACE:-600}"
if [ -f "$PENDING" ]; then
  recovery="$(sed -n 1p "$PENDING")"
  target="$(sed -n 2p "$PENDING")"
  at="$(sed -n 3p "$PENDING")"
  head="$(git rev-parse HEAD 2>/dev/null || true)"
  if ! [[ "$recovery" =~ ^[0-9a-f]{40}$ && "$target" =~ ^[0-9a-f]{40}$ && "$at" =~ ^[0-9]+$ ]] || [ "$head" != "$target" ]; then
    # Illisible, ou le dépôt n'est plus sur la version déployée (Clark est déjà revenu, ou on a changé de
    # version à la main) : le marqueur ne veut plus rien dire.
    rm -f "$PENDING"
    log "filet de déploiement périmé, retiré"
  elif [ $(( $(date +%s) - at )) -ge "$DEPLOY_GRACE" ]; then
    if ! git diff --quiet || ! git diff --cached --quiet; then
      log "déploiement jamais confirmé, mais modifications non commitées : pas de retour arrière automatique"
    elif git switch -q --detach "$recovery" 2>>"$LOG" && [ "$(git rev-parse HEAD)" = "$recovery" ]; then
      echo "$recovery" > data/last-good-commit
      # Annoncé par Clark au démarrage (même format que le retour arrière de scripts/service.sh).
      printf '%s\n%s\n%s\n' "$target" "main" "$recovery" > data/rollback.txt
      rm -f "$PENDING" "$FAILS"
      log "déploiement jamais confirmé : retour à ${recovery:0:7} et relance"
      restart_clark
      exit 0
    else
      log "déploiement jamais confirmé, et le retour à ${recovery:0:7} a échoué"
    fi
  fi
fi

# Délai de grâce après un démarrage.
started="$(cat data/started-at 2>/dev/null || echo 0)"
if [ $(( $(date +%s) - ${started:-0} )) -lt "$GRACE" ]; then
  rm -f "$FAILS"
  exit 0
fi

if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  rm -f "$FAILS"
  exit 0
fi

n=$(( $(cat "$FAILS" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAILS"
log "Clark ne répond pas ($n/2)"
[ "$n" -lt 2 ] && exit 0

rm -f "$FAILS"
date -u +%FT%TZ > data/watchdog-restart.txt
log "relance de Clark"
restart_clark
