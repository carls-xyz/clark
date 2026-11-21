# Clark

**Un agent personnel qui orchestre une équipe d'agents IA, sur mon Mac.** Je lui parle dans une interface web locale ou sur Telegram. Il garde une mémoire, prend des initiatives raisonnables, confie chaque tâche au bon agent et me demande mon accord avant tout ce qui sort ou se défait mal.

Projet personnel commencé en novembre 2026, inspiré de l'agent « Emilien » de @powlisher, d'[OpenBot](https://github.com/nightly-labs/openbot) pour l'usage des agents et d'[Orca](https://github.com/stablyai/orca) pour le travail sur le code.

## Ce que Clark sait faire

- **Orchestrer.** Clark reçoit chaque demande, l'analyse et la confie au bon spécialiste : Mousse (recherche), Braise (rédaction), Guimauve (relecture), Lilas (contenu), Boulon (code). Il attend leurs réponses et fait la synthèse.
- **Coder dans des copies isolées.** Une tâche de code tourne dans un worktree git, sur sa propre branche. Je relis le diff, les tests du projet se lancent, un échec déclenche une correction, puis une PR part sur GitHub. Il peut découper une tâche en sous-tâches parallèles et résoudre les conflits. Il peut aussi travailler sur son propre code, toujours par PR.
- **Se souvenir.** Il propose ses souvenirs, je les confirme, et chacun garde sa source. Il les retrouve par mots et **par le sens**, avec des embeddings locaux. Sa mémoire est aussi un **coffre Obsidian** synchronisé dans les deux sens : je corrige une note, il suit.
- **Prendre des initiatives.** Brief du matin (mails, agenda), tour de veille toutes les 2 h, veille du soir (Hacker News, GitHub, Lobsters…), rappels, automatisations. Il peut décider seul dans un cadre fixé, avec un plafond par jour, et chaque décision s'annule en un clic.
- **Agir sur mes comptes, avec accord.** Gmail et Google Agenda, iMessage, un navigateur Chrome à lui, un terminal, des serveurs MCP. Chaque envoi ou action engageante attend un bouton.
- **Deux moteurs.** Claude (Agent SDK) ou Codex (App Server), sur abonnement, choisis par rôle, avec bascule automatique quand un quota est atteint.

## Comment c'est construit

```
 Interface web (localhost) ─┐                    ┌─ Claude Agent SDK
 Telegram ──────────────────┼─▶ hub : file, ─────┼─ Codex App Server
 Tâches planifiées ─────────┘   validations,     └─ outils MCP : mémoire, mail, agenda,
                                reprise             navigateur, coffre Obsidian, terminal
                                    │
                SQLite : tâches durables, conversations, mémoire (FTS5 + vecteurs), audit
```

- **TypeScript exécuté directement par Node 26**, sans étape de build ; interface en JavaScript et CSS sans framework.
- **SQLite** (`node:sqlite`) pour tout : journal des tâches (reprise après une coupure sans rejouer une action incertaine), conversations, mémoire en texte intégral (FTS5) et vecteurs.
- **Embeddings locaux** (`paraphrase-multilingual-MiniLM-L12-v2`) dans un processus lancé à la demande et arrêté après 2 minutes sans usage : la machine n'a que 8 Go.
- **Service launchd** : Clark démarre avec le Mac et se relance tout seul. Sauvegarde de la base chaque nuit.
- **~31 000 lignes**, **49 fichiers de tests** (`node --test`), aucune dépendance de build.

## Sécurité

C'est un agent qui lit mes mails et le web : il peut se faire manipuler par ce qu'il lit. Les règles sont donc dans le code, pas seulement dans les consignes :
- **Le contenu lu est de la donnée.** Un mail, une page ou un fichier qui demande d'agir est signalé, jamais suivi.
- **Trois niveaux d'action :**
  - ce qui ne change rien passe seul ;
  - ce qui écrit reste dans son dossier ;
  - ce qui sort ou se défait mal (envoi, suppression, commande sur le Mac) attend un bouton, dans l'interface ou sur Telegram.
- **Bac à sable** pour les commandes des agents : pas de réseau, pas d'accès au dossier personnel ni aux secrets.
- **API locale protégée** : hôte et origine vérifiés (pas de DNS rebinding, pas de CSRF).
- **Le terminal ne se valide que sur le Mac**, jamais depuis le téléphone.
- **Chaque appel d'outil est inscrit dans un journal d'audit.**

## Démarrer

Il faut un Mac et Node 26.

```bash
npm install
cp docs/profil.exemple.md memory/profil.md   # ton profil, hors de git
npm start                                     # puis http://localhost:4310
```

Connecte ensuite Claude ou Codex dans Réglages › Moteurs. Tout le reste est facultatif et se branche dans Réglages › Connexions : Google, Telegram, iMessage, Obsidian. Le service, les variables et chaque fonction sont décrits dans le **[mode d'emploi](docs/GUIDE.md)**. Ce qui reste à faire est dans la **[feuille de route](ROADMAP.md)**.

## État

C'est un outil personnel, pas un produit : il tourne sur mon Mac pour moi seul, et son interface est en français. Il est en usage quotidien et évolue presque chaque jour, avec une branche et une PR par changement. Prochaines étapes : un VPS avec Tailscale pour qu'il tourne en permanence, et une mémoire en couches consolidée la nuit.

Développé avec l'aide de Claude Code.
