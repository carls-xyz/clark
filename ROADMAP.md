# Clark : objectifs

Mis à jour le 21 novembre 2026. Ce qui est fait est décrit dans le [mode d'emploi](docs/GUIDE.md) ; ici, ce qui reste.

## 1. Branchements (à faire par l'utilisateur)

- [x] Google : client OAuth (projet « clark »), connecté le 20/11. Reste : remplir Branding puis publier l'appli, sinon reconnexion tous les 7 jours.
- [ ] Codex : Réglages › Moteurs › Connecter Codex.
- [ ] iMessage : Réglages Système › Confidentialité › Accès complet au disque pour `node`.
- [ ] Obsidian : réinstaller l'app et ouvrir le coffre `Documents/Obsidian Vault` pour voir le graphe.
- [ ] Fusionner la PR portfolio #1 (animations des dossiers) après test de l'aperçu sur Safari.

## 2. Recette réelle

- [x] Clark confie une mission à un agent (delegate), attend la réponse, fait la synthèse. (20/11)
- [x] Des décisions prises seul en journée (19 entre le 20 et le 21/11), annulables dans Activité.
- [ ] Le résumé de 21 h des décisions, vu dans la conversation (celui du 20/11 a été supprimé avec sa conversation).
- [x] La relecture de mémoire propose une action (pas seulement des souvenirs). (20/11)
- [x] Accepter une tâche de code lance les tests du projet ; un échec déclenche une correction. (20/11)
- [x] Un conflit entre deux sous-tâches est résolu par un agent, puis la réunion passe. (20/11)
- [ ] Brief du matin avec mails et agenda (réglé à 9 h depuis le 21/11), relance par mail validée par bouton.
- [ ] Après Codex : moteur de secours en cas de quota, regard croisé (Codex rédige, Claude relit).
- [ ] Clark sur lui-même : une première tâche de code sur le projet « clark », jusqu'à la PR fusionnée.

## 3. Fiabilité

- [x] Clark sous git, sans secrets ni données personnelles (profil hors de git depuis le 21/11).
- [x] Dépôt GitHub public en vitrine : carls-xyz/clark. Une branche et une PR par changement, fusion en squash, push direct sur `main` bloqué sur le Mac, versions taguées (v0.2.0).
- [x] Sauvegarde automatique de la base chaque nuit à 3 h dans `data/backups` (7 gardées).
- [x] Interface rangée par zone dans `src/web/app/`. Étape suivante possible : de vrais modules JavaScript.
- [ ] API locale : joignable par tout programme du Mac (accepté pour l'instant, à revoir avec le VPS).
- [ ] Un test de démarrage complet (le plantage « table obsidian_notes » du 21/11 n'était couvert par aucun test).

## 4. Chantiers suivants (chemin « à la Emilien »)

- [x] Terminal dans Clark (21/11), pièces jointes depuis le Finder (21/11).
- [x] Mémoire visible dans Obsidian et recherche par le sens, embeddings locaux (21/11).
- [x] Veille du soir : Hacker News, GitHub Trending, Lobsters, dev.to, nouveautés Shopify (21/11).
- [ ] VPS + Tailscale : Clark allumé 24 h/24, même Mac éteint, accessible depuis l'iPhone. Prérequis de WhatsApp (voie officielle).
- [x] Mémoire en couches : conversations du jour, journal du jour dans Obsidian (relu au début de chaque conversation), souvenirs confirmés (21/11).
- [x] Notes par sujet dans `Clark/Sujets`, reliées aux souvenirs et aux jours du journal (21/11).
- [ ] Consolidation plus longue : un résumé par semaine et par mois à partir des journaux.
- [x] Veille du soir écrite aussi dans Obsidian (`Clark/Veille/`), reliée au journal (21/11).
- [x] Tâches longues : 150 étapes et reprise, tests par l'agent sans clic, tests avant relecture ; pilote automatique jusqu'à la PR (21/11).
- [ ] Auto-amélioration : Clark propose de lui-même ses corrections en PR, relues par l'utilisateur.
- [ ] Réseaux sociaux, suite : Instagram.
- [ ] Idées d'OpenBot restantes : schémas dans la conversation, fichiers produits en cartes.
