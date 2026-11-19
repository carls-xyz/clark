#!/bin/bash
# Clark en service, démarré avec ta session macOS (launchd, agent « local.clark »).
#   scripts/service.sh install    installe et démarre (puis démarre à chaque ouverture de session)
#   scripts/service.sh uninstall  arrête et retire
#   scripts/service.sh restart    redémarre (après une modification de .env ou du code)
#   scripts/service.sh status     état du service
#   scripts/service.sh logs       suit le journal (Ctrl+C pour quitter)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="local.clark"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG="$ROOT/data/logs/clark.log"

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

case "${1:-status}" in
  install)
    write_plist
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    accept_startup_change
    echo "Clark est installé et démarre maintenant. Il redémarrera à chaque ouverture de session."
    echo "Interface : http://localhost:4310 · journal : scripts/service.sh logs"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    accept_startup_change
    echo "Clark est arrêté et ne démarrera plus tout seul."
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Clark redémarre."
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      state=$(launchctl print "$DOMAIN/$LABEL" | awk -F'= ' '/^\tstate = /{print $2; exit}')
      pid=$(launchctl print "$DOMAIN/$LABEL" | awk -F'= ' '/^\tpid = /{print $2; exit}')
      echo "Clark : installé, état « ${state:-inconnu} »${pid:+, processus $pid}."
      [ -f "$LOG" ] && { echo "Dernières lignes du journal :"; tail -n 5 "$LOG"; }
    else
      echo "Clark : pas installé comme service (scripts/service.sh install)."
    fi
    ;;
  logs)
    touch "$LOG"; tail -n 50 -f "$LOG"
    ;;
  *)
    echo "usage : scripts/service.sh install | uninstall | restart | status | logs"; exit 2
    ;;
esac
