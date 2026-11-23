#!/bin/bash
# Restaure une sauvegarde de Clark, prudemment.
#   scripts/restore.sh                      liste les sauvegardes (distantes, et locales), ne touche à rien
#   scripts/restore.sh latest               la dernière sauvegarde distante (restic)
#   scripts/restore.sh <id restic>          une sauvegarde distante précise
#   scripts/restore.sh local:<fichier.db>   une sauvegarde locale (data/backups/, la base seulement)
#   --yes                                   sans demander de taper RESTAURER (pour un script)
#
# 1. Restaure dans un dossier temporaire et vérifie (intégrité de la base, manifeste).
# 2. Montre ce qui va être remplacé, demande de taper RESTAURER.
# 3. Arrête Clark (la surveillance locale le laisse arrêté), met l'existant de côté dans
#    data/backups/avant-restauration-<date>/ (rien n'est supprimé), remet les fichiers, relance Clark.
# .env n'est jamais touché : il n'est pas dans les sauvegardes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
WHAT="${1:-}"
YES=""
for a in "$@"; do [ "$a" = "--yes" ] && YES=1; done
[ "$WHAT" = "--yes" ] && WHAT=""

if [ -z "$WHAT" ]; then
  echo "Sauvegardes locales (la base seulement) :"
  ls -1 data/backups/clark-*.db 2>/dev/null | sed 's#.*/#  local:#' || echo "  aucune"
  echo
  if grep -qE '^CLARK_BACKUP_REPO=.+' .env 2>/dev/null || [ -n "${CLARK_BACKUP_REPO:-}" ]; then
    echo "Sauvegardes distantes :"
    node scripts/backup.ts snapshots || true
  else
    echo "Pas de sauvegarde distante (CLARK_BACKUP_REPO vide)."
  fi
  echo
  echo "Puis : scripts/restore.sh latest | <id> | local:<fichier.db>"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "── Restauration à part, puis vérification"
DIR="$(node scripts/backup.ts fetch "$WHAT" "$TMP/lot" | tail -n1)"
[ -f "$DIR/data/clark.db" ] || { echo "Pas de base dans cette sauvegarde : rien n'est touché." >&2; exit 1; }

echo
echo "── Ce qui va être remplacé"
[ -f "$DIR/manifest.json" ] && node -e 'const m=require(process.argv[1]);console.log(`  sauvegarde du ${new Date(m.at).toLocaleString("fr-FR",{timeZone:"Europe/Paris"})} (${m.host}${m.commit?`, version ${m.commit}`:""}), ${m.files.length} fichiers`)' "$DIR/manifest.json"
for p in data/clark.db memory personnalite.md data/google workspace; do
  [ -e "$DIR/$p" ] && echo "  $p"
done
echo "  (l'existant est mis de côté, rien n'est supprimé ; .env n'est pas touché)"

if [ -z "$YES" ]; then
  printf '\nTape RESTAURER pour continuer : '
  read -r answer
  [ "$answer" = "RESTAURER" ] || { echo "Annulé : rien n'a été touché."; exit 1; }
fi

echo "── Arrêt de Clark"
scripts/service.sh stop

STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
ASIDE="data/backups/avant-restauration-$STAMP"
mkdir -p "$ASIDE/data"
echo "── Mise de côté dans $ASIDE"
for f in data/clark.db data/clark.db-wal data/clark.db-shm; do [ -e "$f" ] && mv "$f" "$ASIDE/$f"; done
for p in memory personnalite.md data/google workspace; do
  if [ -e "$DIR/$p" ] && [ -e "$p" ]; then mkdir -p "$ASIDE/$(dirname "$p")"; mv "$p" "$ASIDE/$p"; fi
done
# Les copies des tâches dev ne sont pas dans les sauvegardes : elles restent à leur place.
[ -d "$ASIDE/workspace/dev" ] && mkdir -p workspace && mv "$ASIDE/workspace/dev" workspace/dev

echo "── Remise en place"
cp "$DIR/data/clark.db" data/clark.db
for p in memory personnalite.md data/google workspace; do
  [ -e "$DIR/$p" ] || continue
  mkdir -p "$(dirname "$p")"
  if [ -d "$DIR/$p" ]; then mkdir -p "$p" && cp -R "$DIR/$p/." "$p/"; else cp "$DIR/$p" "$p"; fi
done
[ -d data/google ] && chmod 600 data/google/* 2>/dev/null || true

echo "── Redémarrage"
if scripts/service.sh start; then
  echo
  echo "Restauré. L'ancien état est dans $ASIDE (à supprimer quand tout va bien)."
else
  echo
  echo "Clark ne répond pas après la restauration. Pour revenir à l'état d'avant :"
  echo "  scripts/service.sh stop && cp $ASIDE/data/clark.db data/clark.db && scripts/service.sh start"
  exit 1
fi
