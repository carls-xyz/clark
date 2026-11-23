# Interface de Clark, rangée par zone

Le serveur assemble ces fichiers dans l'ordre de leur nom (`appScript()` dans `src/gateway/web.ts`)
et sert le tout sous `/app.js`. Ils partagent la même portée, comme un seul fichier : une fonction
définie dans `08-dev.js` est utilisable dans `14-navigation.js`. Pas d'étape de compilation.

Pour ajouter une zone : un nouveau fichier `NN-nom.js`, à la place qui convient dans l'ordre.
Le code qui s'exécute au chargement (écouteurs, démarrage) doit venir après ce qu'il utilise.
- `18-terminal.js` : le Terminal (tes commandes, celles que Clark propose), relu par `/api/terminal` pendant qu'une commande tourne.
- `19-gestion-conversations.js` : le menu ⋯ d'une conversation (renommer, épingler, supprimer) et le tri de la liste.
- `20-idees.js` : la page Idées (tour d'idées, idées lancées en vrac, avis de Clark, tri).
- `21-calendrier.js` : le Calendrier des veilles (comptes rendus des automatisations rangées dans le calendrier, par jour).
- `22-activite-notes.js` : Activité › « Ce qui s'est passé » (les notes sorties de ta conversation : dev, PR, mémoire, propositions…).
- `23-sante.js` : la page Santé (file, moteurs et quotas, sauvegarde, version, place, échecs et erreurs du journal).
- `24-vue-distante.js` : la vue distante du navigateur (te connecter à un site sur un serveur sans écran, ou depuis le téléphone).
