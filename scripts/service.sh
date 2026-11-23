#!/bin/bash
# Clark en service : launchd sur le Mac (agent « local.clark »), systemd sur Linux (unité utilisateur « clark »).
#   scripts/service.sh install    installe et démarre (puis démarre tout seul : ouverture de session, ou démarrage du serveur),
#                                 avec la surveillance locale (scripts/watchdog.sh toutes les 5 minutes)
#   scripts/service.sh uninstall  arrête et retire
#   scripts/service.sh stop|start arrête / relance sans désinstaller (restauration, maintenance)
#   scripts/service.sh restart    redémarre (après une modification de .env ou du code), puis vérifie que Clark répond
#   scripts/service.sh status     état du service
#   scripts/service.sh logs       suit le journal (Ctrl+C pour quitter)
#
# Filet de sécurité : après install ou restart, on attend que Clark réponde (40 s au plus).
# S'il répond, la version est notée bonne (data/last-good-commit). S'il ne répond pas et qu'une
# version bonne est connue, on y revient (git switch --detach) et on redémarre : Clark te le dit
# au démarrage. Pas de retour si tu as des modifications non commitées, ni avec CLARK_NO_ROLLBACK=1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/data/logs/clark.log"
GOOD="$ROOT/data/last-good-commit"
ROLLBACK_NOTE="$ROOT/data/rollback.txt"
OS="$(uname -s)"

# Port de l'interface : celui de .env, sinon 4310.
PORT="$(grep -E '^CLARK_WEB_PORT=' "$ROOT/.env" 2>/dev/null | tail -n1 | cut -d= -f2 | tr -d ' "'\''' || true)"
PORT="${CLARK_WEB_PORT:-${PORT:-4310}}"
# Attente max que Clark réponde (s), et faux service pour les tests (aucun launchd/systemd touché).
WAIT="${CLARK_HEALTH_WAIT:-40}"
FAKE="${CLARK_SERVICE_FAKE:-}"

# ── macOS : launchd ──────────────────────────────────────────────────
LABEL="local.clark"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

write_plist() {
  mkdir -p "$ROOT/data/logs" "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$ROOT/scripts/run-clark.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <!-- Redémarre s'il plante ; pas s'il s'arrête proprement (service.sh uninstall, ou arrêt demandé). -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>Nice</key><integer>5</integer>
  <key>StandardErrorPath</key><string>$ROOT/data/logs/launchd.log</string>
</dict>
</plist>
PLIST
  plutil -lint "$PLIST" >/dev/null
}

accept_startup_change() {
  # L'optimisation du Mac surveille les agents de démarrage : on lui dit que celui-ci est voulu.
  local check="$HOME/Library/Application Support/optimisation-mac/09-demarrage.sh"
  [ -x "$check" ] && "$check" --accepter >/dev/null 2>&1 || true
}

# ── Linux : systemd (unité utilisateur) ──────────────────────────────
UNIT="$HOME/.config/systemd/user/clark.service"

write_unit() {
  mkdir -p "$ROOT/data/logs" "$(dirname "$UNIT")"
  cat > "$UNIT" <<UNIT
[Unit]
Description=Clark, agent personnel
After=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$ROOT/scripts/run-clark.sh
# Permet à Clark de se relancer lui-même (bouton « Redémarrer Clark ») : systemd le relance après une sortie non nulle.
Environment=CLARK_SERVICE=systemd
Restart=on-failure
RestartSec=30
Nice=5

[Install]
WantedBy=default.target
UNIT
}

# ── Surveillance locale (scripts/watchdog.sh, toutes les 5 minutes) ──
WD_LABEL="local.clark.watchdog"
WD_PLIST="$HOME/Library/LaunchAgents/$WD_LABEL.plist"
WD_UNIT_DIR="$HOME/.config/systemd/user"

watchdog_install() {
  if [ "$OS" = "Darwin" ]; then
    cat > "$WD_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$WD_LABEL</string>
  <key>ProgramArguments</key><array><string>$ROOT/scripts/watchdog.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardErrorPath</key><string>$ROOT/data/logs/watchdog.log</string>
</dict>
</plist>
PLIST
    plutil -lint "$WD_PLIST" >/dev/null
    launchctl bootout "$DOMAIN/$WD_LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$WD_PLIST"
  else
    mkdir -p "$WD_UNIT_DIR"
    cat > "$WD_UNIT_DIR/clark-watchdog.service" <<UNIT
[Unit]
Description=Clark : vérifie qu'il répond

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$ROOT/scripts/watchdog.sh
UNIT
    cat > "$WD_UNIT_DIR/clark-watchdog.timer" <<UNIT
[Unit]
Description=Clark : vérification toutes les 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now clark-watchdog.timer
  fi
}

watchdog_remove() {
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "$DOMAIN/$WD_LABEL" 2>/dev/null || true
    rm -f "$WD_PLIST"
  else
    systemctl --user disable --now clark-watchdog.timer 2>/dev/null || true
    rm -f "$WD_UNIT_DIR/clark-watchdog.service" "$WD_UNIT_DIR/clark-watchdog.timer"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
}

# ── Commun ───────────────────────────────────────────────────────────
svc_start_fresh() {
  if [ "$OS" = "Darwin" ]; then
    write_plist
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    accept_startup_change
  else
    write_unit
    systemctl --user daemon-reload
    systemctl --user enable --now clark.service
  fi
}

svc_restart() {
  if [ -n "$FAKE" ]; then "$FAKE" restart; return; fi
  if [ "$OS" = "Darwin" ]; then launchctl kickstart -k "$DOMAIN/$LABEL"; else systemctl --user restart clark.service; fi
}

svc_stop_remove() {
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    accept_startup_change
  else
    systemctl --user disable --now clark.service 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
  fi
}

# Clark répond-il ? ($WAIT s au plus, 40 par défaut : le démarrage relit la base et les moteurs.)
healthy() {
  local i
  sleep 1
  for i in $(seq 1 "$WAIT"); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

head_commit() { git -C "$ROOT" rev-parse HEAD 2>/dev/null || true; }

# Après un démarrage : version notée bonne, ou retour à la dernière bonne.
check_or_rollback() {
  local now good from
  now="$(head_commit)"
  if healthy; then
    [ -n "$now" ] && echo "$now" > "$GOOD"
    echo "Clark répond (http://localhost:$PORT)."
    return 0
  fi
  echo "Clark ne répond pas après $WAIT s. Journal : scripts/service.sh logs"
  good="$(cat "$GOOD" 2>/dev/null || true)"
  if [ -n "${CLARK_NO_ROLLBACK:-}" ] || [ -z "$good" ] || [ -z "$now" ] || [ "$good" = "$now" ]; then
    echo "Pas de version précédente où revenir : à corriger à la main."
    return 1
  fi
  if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
    echo "Tu as des modifications non commitées : je ne reviens pas en arrière tout seul."
    echo "Version qui marchait : $good (git switch --detach $good, puis scripts/service.sh restart)."
    return 1
  fi
  from="$(git -C "$ROOT" symbolic-ref --short -q HEAD || echo "$now")"
  echo "Je reviens à la dernière version qui marchait : ${good:0:7}."
  git -C "$ROOT" switch -q --detach "$good"
  printf '%s\n%s\n%s\n' "$now" "$from" "$good" > "$ROLLBACK_NOTE"
  svc_restart
  if healthy; then
    echo "Clark répond de nouveau, sur la version ${good:0:7}. La version ${now:0:7} (${from}) ne démarrait pas."
    echo "Une fois corrigé : git switch $from && scripts/service.sh restart"
    return 1
  fi
  echo "Clark ne répond toujours pas, même sur ${good:0:7} : regarde le journal (scripts/service.sh logs)."
  return 1
}

case "${1:-status}" in
  install)
    svc_start_fresh
    watchdog_install
    if [ "$OS" = "Darwin" ]; then
      echo "Clark est installé et démarre maintenant. Il redémarrera à chaque ouverture de session."
    else
      echo "Clark est installé et démarre maintenant."
      echo "Pour qu'il tourne sans session ouverte (serveur) : sudo loginctl enable-linger $USER"
    fi
    check_or_rollback
    echo "Journal : scripts/service.sh logs"
    ;;
  uninstall)
    watchdog_remove
    svc_stop_remove
    echo "Clark est arrêté et ne démarrera plus tout seul."
    ;;
  stop)
    # Arrêt sans désinstaller (restauration, maintenance) : la surveillance locale le laisse arrêté.
    if [ -n "$FAKE" ]; then "$FAKE" stop
    elif [ "$OS" = "Darwin" ]; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    else systemctl --user stop clark.service
    fi
    echo "Clark est arrêté (scripts/service.sh start pour le relancer)."
    ;;
  start)
    if [ -n "$FAKE" ]; then "$FAKE" start
    elif [ "$OS" = "Darwin" ]; then [ -f "$PLIST" ] || write_plist; launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || launchctl kickstart -k "$DOMAIN/$LABEL"
    else systemctl --user start clark.service
    fi
    echo "Clark démarre."
    healthy && echo "Clark répond (http://localhost:$PORT)." || { echo "Clark ne répond pas : scripts/service.sh logs"; exit 1; }
    ;;
  restart)
    # Installé avant la surveillance locale : elle est ajoutée au passage.
    if [ -z "$FAKE" ] && [ ! -f "$WD_PLIST" ] && [ ! -f "$WD_UNIT_DIR/clark-watchdog.timer" ]; then watchdog_install && echo "Surveillance locale ajoutée (toutes les 5 minutes)."; fi
    svc_restart
    echo "Clark redémarre."
    check_or_rollback
    ;;
  status)
    if [ "$OS" = "Darwin" ]; then
      if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        state=$(launchctl print "$DOMAIN/$LABEL" | awk -F'= ' '/^\tstate = /{print $2; exit}')
        pid=$(launchctl print "$DOMAIN/$LABEL" | awk -F'= ' '/^\tpid = /{print $2; exit}')
        echo "Clark : installé, état « ${state:-inconnu} »${pid:+, processus $pid}."
      else
        echo "Clark : pas installé comme service (scripts/service.sh install)."
      fi
    else
      if [ -f "$UNIT" ]; then
        echo "Clark : installé, état « $(systemctl --user is-active clark.service 2>/dev/null || echo inconnu) »."
      else
        echo "Clark : pas installé comme service (scripts/service.sh install)."
      fi
    fi
    if [ -f "$WD_PLIST" ] || [ -f "$WD_UNIT_DIR/clark-watchdog.timer" ]; then echo "Surveillance locale : active (toutes les 5 minutes)."; else echo "Surveillance locale : absente (scripts/service.sh install)."; fi
    [ -f "$GOOD" ] && echo "Dernière version qui a démarré : $(cut -c1-7 "$GOOD")."
    [ -f "$LOG" ] && { echo "Dernières lignes du journal :"; tail -n 5 "$LOG"; }
    ;;
  logs)
    mkdir -p "$(dirname "$LOG")"; touch "$LOG"; tail -n 50 -f "$LOG"
    ;;
  *)
    echo "usage : scripts/service.sh install | uninstall | start | stop | restart | status | logs"; exit 2
    ;;
esac
