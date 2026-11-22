# Clark

Un agent personnel qui tourne sur Mac. On lui parle depuis une interface web locale ou sur Telegram. Il répartit le travail entre plusieurs agents spécialisés, garde une mémoire, et demande un accord avant toute action qui sort de la machine.

## Fonctions

- **Équipe d'agents** : recherche, rédaction, relecture, contenu et code, coordonnés par Clark.
- **Tâches de code** : chaque tâche tourne dans un worktree git isolé. Les tests se lancent, puis une PR est ouverte sur GitHub.
- **Mémoire** : souvenirs confirmés, recherche par le sens (embeddings locaux), journal quotidien, synchronisation avec un coffre Obsidian.
- **Routines** : brief du matin, veille, rappels, automatisations.
- **Connexions** : Gmail, Google Agenda, iMessage, navigateur, terminal, serveurs MCP.
- **Moteurs** : Claude (Agent SDK) ou Codex (App Server).

## Stack

- TypeScript exécuté directement par Node 26, sans build
- SQLite (`node:sqlite`) : tâches, conversations, mémoire (FTS5 + vecteurs)
- Interface web en JavaScript et CSS, sans framework
- Service launchd pour le démarrage automatique
- Tests avec `node --test`

## Sécurité

- Le contenu lu (mails, pages, fichiers) est traité comme de la donnée, jamais comme des instructions.
- Les envois, suppressions et commandes système attendent une validation par bouton.
- Les commandes des agents tournent dans un bac à sable, sans réseau ni accès aux secrets.
- Chaque appel d'outil est inscrit dans un journal d'audit.

## Démarrer

Il faut un Mac et Node 26.

```bash
npm install
cp docs/profil.exemple.md memory/profil.md
npm start
```

Ensuite, ouvrir http://localhost:4310 et connecter un moteur dans Réglages › Moteurs.

Le détail est dans le [mode d'emploi](docs/GUIDE.md), la suite dans la [feuille de route](ROADMAP.md).

Développé avec l'aide de Claude Code.
