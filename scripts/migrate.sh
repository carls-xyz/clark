#!/bin/bash
# Migre Clark de ce Mac vers un serveur déjà installé (scripts/install-linux.sh), par SSH :
#   scripts/migrate.sh moi@serveur [dossier de Clark sur le serveur, ~/clark par défaut]
#
# Copié : la base (copie à chaud, cohérente), la connexion Google, la connexion ChatGPT de Codex et ses
# fils, le dossier de travail, la mémoire cœur, la dernière sauvegarde, ton .env (en .env.mac, à fusionner).
# Pas copié : la connexion Claude (dans le Trousseau du Mac : à refaire), le profil du navigateur (cookies
# chiffrés par le Trousseau : reconnecte-toi aux sites avec la vue distante), journaux, caches, modèles.
# Les projets dev sont re-clonés sur le serveur et leurs chemins mis à jour (scripts/relocate-projects.ts).
#
# Le service du serveur est arrêté pendant la copie, puis relancé. Clark sur ce Mac n'est pas touché :
# arrête-le toi-même (scripts/service.sh uninstall) une fois le serveur vérifié, pour ne pas avoir deux Clark.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEST="${1:?usage : scripts/migrate.sh moi@serveur [dossier distant]}"
DIR="${2:-clark}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
step() { printf '\n── %s\n' "$1"; }
remote() { ssh "$DEST" "cd $DIR && $*"; }

step "Serveur"
remote "test -f package.json && test -x scripts/service.sh" || { echo "Clark n'est pas installé dans ~/$DIR sur $DEST (scripts/install-linux.sh)." >&2; exit 1; }

step "Copie à chaud de la base"
sqlite3 data/clark.db "VACUUM INTO '$TMP/clark.db'"
[ "$(sqlite3 "$TMP/clark.db" 'PRAGMA integrity_check;')" = "ok" ] || { echo "Copie de la base abîmée : rien n'est envoyé." >&2; exit 1; }

step "Projets dev (adresse de leur dépôt, pour les re-cloner)"
{
  printf 'clark_root\t%s\n' "$ROOT"
  sqlite3 -separator $'\t' data/clark.db "SELECT id, name, path FROM projects" | while IFS=$'\t' read -r id name path; do
    url="$(git -C "$path" remote get-url origin 2>/dev/null || true)"
    printf '%s\t%s\t%s\t%s\n' "$id" "$name" "$path" "$url"
  done
} > "$TMP/projects.tsv"
cat "$TMP/projects.tsv"

step "Arrêt de Clark sur le serveur"
ssh "$DEST" "systemctl --user stop clark.service 2>/dev/null || true"

step "Envoi"
remote "mkdir -p data/google data/codex-home data/backups && rm -f data/clark.db-wal data/clark.db-shm"
rsync -az "$TMP/clark.db" "$DEST:$DIR/data/clark.db"
rsync -az "$TMP/projects.tsv" "$DEST:$DIR/data/migration-projects.tsv"
[ -f data/google/token.json ] && rsync -az data/google/token.json "$DEST:$DIR/data/google/token.json"
[ -f data/codex-home/auth.json ] && rsync -az data/codex-home/auth.json "$DEST:$DIR/data/codex-home/auth.json"
[ -d data/codex-home/sessions ] && rsync -az data/codex-home/sessions/ "$DEST:$DIR/data/codex-home/sessions/"
[ -d workspace ] && rsync -az --exclude 'dev/' workspace/ "$DEST:$DIR/workspace/"
[ -d memory ] && rsync -az memory/ "$DEST:$DIR/memory/"
last="$(ls -1 data/backups/clark-*.db 2>/dev/null | tail -n1 || true)"
[ -n "$last" ] && rsync -az "$last" "$DEST:$DIR/data/backups/"
[ -f .env ] && rsync -az --chmod=F600 .env "$DEST:$DIR/.env.mac"
remote "chmod 600 data/google/token.json data/codex-home/auth.json 2>/dev/null || true"

step "Projets : re-clonés et chemins mis à jour"
remote "node scripts/relocate-projects.ts data/migration-projects.tsv"

step "Démarrage de Clark sur le serveur"
remote "scripts/service.sh restart" || true

cat <<EOF

Migré. À faire sur le serveur :
  1. Fusionner .env.mac dans .env : garder tes clés et jetons, retirer les chemins du Mac
     (CLARK_OBSIDIAN_VAULT, CLARK_BROWSER_EXECUTABLE, CLARK_IMESSAGE_*), ajouter CLARK_WEB_HOSTS. Puis : rm .env.mac
  2. Claude : Réglages › Moteurs › Connecter Claude (la connexion du Mac est dans son Trousseau).
  3. Sites : Réglages › Connexions › Navigateur › Se connecter à un site.
  4. Coffre Obsidian : synchronisé sur le serveur, puis CLARK_OBSIDIAN_VAULT dans .env.
  5. scripts/service.sh restart, puis la page Santé.
Une fois le serveur vérifié, sur ce Mac : scripts/service.sh uninstall (un seul Clark à la fois).
EOF
