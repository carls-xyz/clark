# Interface de Clark, rangée par zone

Le serveur assemble ces fichiers dans l'ordre de leur nom (`appScript()` dans `src/gateway/web.ts`)
et sert le tout sous `/app.js`. Ils partagent la même portée, comme un seul fichier : une fonction
définie dans `08-dev.js` est utilisable dans `14-navigation.js`. Pas d'étape de compilation.

Pour ajouter une zone : un nouveau fichier `NN-nom.js`, à la place qui convient dans l'ordre.
Le code qui s'exécute au chargement (écouteurs, démarrage) doit venir après ce qu'il utilise.
- `18-terminal.js` : le Terminal (tes commandes, celles que Clark propose), relu par `/api/terminal` pendant qu'une commande tourne.
- `19-gestion-conversations.js` : le menu ⋯ d'une conversation (renommer, épingler, supprimer) et le tri de la liste.
