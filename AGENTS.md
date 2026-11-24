# Règles du projet Clark, pour les agents de code

Ces règles valent pour tout agent qui touche ce dépôt : celui qui planifie, celui qui écrit, celui qui relit.
Le relecteur vérifie qu'elles sont respectées, comme un point **bloquant** si ce n'est pas le cas.

## Sécurité (non négociable)

- **Accords.** Une demande d'accord ne vaut oui que si la réponse est exactement `"ok"` (ou `true`). Refusé, expiré, agent arrêté : non. Ne teste jamais une réponse d'accord par sa « vérité » (`if (!ok)`) : une chaîne comme `"no"` est vraie en JavaScript. Une seule demande d'accord en attente à la fois pour une même ressource, et une seconde ne remplace jamais la première.
- **Navigateur.** Toute action d'un agent dans le navigateur (mode texte, mode vision, ou nouveau mode) passe par les règles des sites sensibles (`src/browser/sensitive.ts` : banque, paiement, crypto, mots de passe, identité, comptes Apple/Google/Microsoft) : contrôle de l'adresse avant l'action, puis de l'adresse finale de chaque onglet après. Rien d'une page sensible (texte, titre, capture) n'arrive à l'agent, dans le journal ou dans les logs. Pendant la vue distante de l'utilisateur, et tant qu'une page sensible qu'il a ouverte reste ouverte, l'agent n'a pas la main.
- **Jeton interne.** Ce que sert l'adresse interne (`X-Clark-Internal`, utilisé par Codex) est fait pour l'agent : jamais la vue distante de l'utilisateur, jamais une capture ou une donnée qui ne lui est pas destinée.
- **Lecture seule.** Une tâche en accès `read` n'écrit rien, par aucun outil. Un nouvel outil qui écrit ou agit doit être classé comme tel (`effectOf`, `src/policy/permissions.ts`) et refusé en lecture seule.
- **Secrets.** Jamais de `.env`, de `data/`, de jeton ou de clé dans un commit, un log, un message ou une sauvegarde. Jamais un agent qui tape un mot de passe, un numéro de carte ou un code.
- **Pas de nouvelle permission silencieuse.** Ce qui envoie, publie, paie, supprime ou engage l'utilisateur attend son accord.

## Contrats partagés

- Avant de changer la forme d'une fonction partagée (type de retour, paramètres, signification d'une valeur), cherche **tous** ses appelants (`rg`) et adapte-les ; dis dans ton résumé ce que tu as changé et où.
- Un changement de comportement visible (règle, accord, sécurité) va avec un test qui le prouve.

## Code

- TypeScript lancé directement par Node (pas de compilation) : pas d'`enum`, de `namespace` ni de syntaxe non effaçable.
- Interface : les fichiers `src/web/app/NN-*.js` sont mis bout à bout dans une seule portée. Attention aux noms en double ; `var` pour un état lu au chargement par un fichier précédent.
- Design « sobre » : pas de verre dépoli, de grain, de lueur, d'italique décoratif, de rebond ni d'effet au pointeur.
- Commentaires : « l'utilisateur ». Consignes des agents : « Charles ». Français, ton du dépôt.

## Vérifier

- `npm run typecheck` et `npm test` (fuseau `Europe/Paris`). Dans le bac à sable, certains tests (serveur HTTP local) peuvent ne pas tourner : Clark relance les tests hors du bac à sable et donne le résultat au relecteur.
