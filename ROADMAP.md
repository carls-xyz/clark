# Clark : objectifs

Mis à jour le 20 novembre 2026. Ce qui est fait est décrit dans le README ; ici, ce qui reste.

## 1. Branchements (Charles)

- [x] Google : client OAuth créé (projet « clark », en mode test avec Charles comme testeur), connecté le 20/11. Reste : remplir Branding puis publier, sinon reconnexion tous les 7 jours.
- [ ] Codex : Réglages › Moteurs › Connecter Codex. Prévu le 20/11.
- [ ] iMessage : Réglages Système › Confidentialité › Accès complet au disque pour `node`.
- [ ] Fusionner la PR portfolio #1 (animations des dossiers) après test de l'aperçu sur Safari.

## 2. Recette réelle

- [x] Clark confie une mission à un agent (delegate), attend la réponse, fait la synthèse. (20/11, Mousse sur le portfolio)
- [ ] Une décision prise seul en journée (tour de veille), puis le résumé de 21 h.
- [x] La relecture de mémoire propose une action (pas seulement des souvenirs). (20/11, relance alternance)
- [x] Accepter une tâche de code lance les tests du projet ; un échec déclenche une correction. (20/11, dépôt clark-recette-code)
- [x] Un conflit entre deux sous-tâches est résolu par un agent, puis la réunion passe. (20/11, dépôt clark-recette-conflit)
- [ ] Après Google : brief du matin avec mails et agenda, relance par mail validée par bouton.
- [ ] Après Codex : moteur de secours en cas de quota, regard croisé (Codex rédige, Claude relit).

## 3. Fiabilité

- [x] Clark sous git (sans secrets ni données personnelles).
- [x] Dépôt GitHub privé : carls-xyz/clark.
- [x] Ménage des sauvegardes de base dans `data/` (anciennes à la Corbeille) ; sauvegarde automatique chaque nuit à 3 h dans `data/backups` (7 gardées).
- [x] Interface rangée par zone dans `src/web/app/` (18 fichiers, assemblés par le serveur). Étape suivante possible : de vrais modules JavaScript, zone par zone.
- [ ] API locale : joignable par tout programme du Mac (accepté pour l'instant, à revoir avec le VPS).

## 4. Chantiers suivants (chemin « à la Emilien »)

- [ ] VPS + Tailscale : Clark allumé 24 h/24, même Mac éteint. Prérequis de WhatsApp (voie officielle).
- [ ] Auto-amélioration : Clark propose ses propres corrections en PR, relues par Charles.
- [ ] Réseaux sociaux, suite : Instagram, Reddit.
- [ ] Idées d'OpenBot restantes : schémas dans la conversation, fichiers produits en cartes.
