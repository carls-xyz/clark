#!/bin/bash
# Installe Clark sur un serveur Ubuntu 24.04 (x86_64), depuis le dossier du dépôt cloné :
#   git clone https://github.com/carls-xyz/clark.git ~/clark && cd ~/clark && scripts/install-linux.sh
#
# Le script s'arrête à la première erreur et peut être relancé : ce qui est déjà en place est sauté.
# Il demande ton mot de passe (sudo) pour les paquets système, Tailscale et le démarrage sans session.
# Après : connexions (claude auth login…), .env, puis scripts/service.sh restart. Voir docs/GUIDE.md › Serveur Linux.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${CLARK_WEB_PORT:-4310}"
step() { printf '\n── %s\n' "$1"; }
has() { command -v "$1" >/dev/null 2>&1; }

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "Ce script vise Ubuntu 24.04 x86_64 (Chrome n'existe pas en ARM sous Linux)." >&2
  exit 1
fi

step "Paquets système (shell, git, compilation de whisper, vidéo, bac à sable de Claude, sqlite, sauvegardes restic)"
sudo apt-get update
sudo apt-get install -y git zsh curl ca-certificates build-essential cmake ffmpeg bubblewrap socat sqlite3 unzip rsync fonts-dejavu-core restic

step "Node 26"
if ! has node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 26 ]; then
  curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

step "Outils des moteurs (Claude Code, Codex) et GitHub"
has claude || sudo npm install -g @anthropic-ai/claude-code
has codex || sudo npm install -g @openai/codex
has gh || sudo apt-get install -y gh

step "Chrome (navigateur de Clark, textes des vidéos)"
if ! has google-chrome; then
  curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get install -y /tmp/chrome.deb
  rm -f /tmp/chrome.deb
fi

step "whisper (dictée)"
if ! has whisper-cli; then
  rm -rf /tmp/whisper.cpp
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp
  cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release
  cmake --build /tmp/whisper.cpp/build -j --target whisper-cli
  sudo install -m 755 /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
  rm -rf /tmp/whisper.cpp
fi
mkdir -p data/whisper
[ -s data/whisper/ggml-small.bin ] || curl -fL -o data/whisper/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin

step "Clark"
npm ci
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Créé : .env (à remplir)."
fi
chmod 600 .env

step "Tailscale (accès depuis le téléphone)"
has tailscale || curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale status >/dev/null 2>&1 || sudo tailscale up
sudo tailscale serve --bg "$PORT"
NAME="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).Self?.DNSName||"").replace(/\.$/,""))}catch{}})')"

step "Service (démarre sans session ouverte, et au démarrage du serveur)"
sudo loginctl enable-linger "$USER"
scripts/service.sh install || true

cat <<EOF

Installé. Il reste, une fois :
  1. Claude : Réglages › Moteurs › Connecter Claude (lien + code), ou ici :
       CLAUDE_CONFIG_DIR="$ROOT/data/claude-home" claude auth login      (ou ANTHROPIC_API_KEY dans .env)
  2. Codex  : inutile si auth.json a été migré ; sinon Réglages › Moteurs › Connecter Codex, ou ici :
       CODEX_HOME="$ROOT/data/codex-home" codex login      (ou OPENAI_API_KEY dans .env)
  3. Dans .env : CLARK_WEB_HOSTS=${NAME:-ton-serveur.ton-reseau.ts.net}  et  CLARK_TAILSCALE_USERS=ton compte Tailscale
  4. scripts/service.sh restart
  5. Sur l'iPhone : https://${NAME:-ton-serveur.ton-reseau.ts.net}, puis Réglages › Connexions › Navigateur › Se connecter à un site
EOF
