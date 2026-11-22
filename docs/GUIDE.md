# Clark — mode d'emploi

La présentation courte est dans le [README](../README.md). Ici, tout le détail.

Agent personnel. On lui parle dans son interface web locale, ou sur Telegram depuis le téléphone : c'est la même conversation. Il garde une mémoire durable et il prend des initiatives. Pour l'instant, cela se limite à un brief chaque matin.

Deux moteurs au choix, avec le même journal, les mêmes validations et la même mémoire :
- **Claude** : le Claude Agent SDK, sur ton **abonnement Claude**, sans clé API, ou sur une clé API Anthropic si tu en mets une.
- **Codex** : le Codex App Server officiel, sur ton abonnement ChatGPT, sans clé API.

Avec `CLARK_ENGINE` vide, Clark choisit lui-même au démarrage, dans cet ordre :
1. Claude, si ton compte Claude (ou une clé API) est disponible ;
2. sinon Codex, s'il est connecté ;
3. sinon Claude, et l'interface affiche la connexion à faire.

## L'interface

Une interface simple : une barre légère à gauche, la conversation au centre, le reste rangé.
- **Barre de gauche** : Nouvelle conversation, « Aller à, lancer » (⌘K), **Activité** (avec le nombre de choses qui t'attendent), puis seulement les fils **en cours** (objectifs, groupes, tâches dev, avec une pastille d'état). En bas : Réglages et le quota le plus entamé. Un clic sur « Clark » ramène à la conversation.
- **Conversation** : sans bandeau. Vide (au démarrage, ou après « Nouvelle conversation »), elle montre la date, le champ au milieu et trois raccourcis (ce qui t'attend, tâche de code, objectif) ; le champ descend au premier message. Le nom de Clark n'apparaît qu'au début d'une série de réponses ; l'heure et « Écouter » au survol (toujours visibles sur téléphone). Les accords, questions, vidéos et mails à valider y arrivent en cartes ; trois notes système ou plus d'affilée se replient en une ligne.
- **Champ de message** : « + » ouvre les autres façons de demander (tâche de code, code en parallèle, comparer deux agents, objectif, équipe) ; le choix s'affiche en pastille, × pour revenir au message simple. Puis le modèle (un clic : modèle, effort, quota), le micro et Envoyer.
- **Activité** : un seul flux, comme le fil « Agents » d'Orca. **T'attend** (accords, questions, décisions, relectures, agents silencieux, souvenirs à confirmer, propositions), **En cours**, puis **Fini** (l'historique, avec des titres lisibles : « Retouche · <tâche> », « Tour de veille »…). Un filtre en haut. Les anciennes adresses `#a-toi` et `#historique` y mènent.
- **Page d'une tâche dev** : le titre en haut, le résumé, les fichiers et le diff, puis **Accepter**, **Aperçu**, le champ de retouche et « … » pour le reste (tests, tours de l'agent, comparer, réessayer, détails, jeter).
- **Réglages**, en six rubriques : Général (apparence, notifications, personnalité, voix), Moteurs, Connexions (Google, Telegram, iMessage, navigateur, serveurs MCP, plugins), Projets dev, Automatisations, Avancé (fonctionnement, commandes, skills, mémoire, dépense, sauvegarde).
- **Clark, la mascotte** (en bas à droite ; en haut à droite sur téléphone) : le bonhomme bleu montre l'état réel. Il marche quand un agent travaille, lève un « ! » quand quelque chose t'attend, somnole pendant tes heures calmes, porte un « ? » si son moteur n'est pas connecté, et grisonne si la connexion est coupée. Un clic : son état, « Voir ce qui t'attend », la tâche en cours, « Me cacher » (Réglages › Général › Apparence le fait revenir).
- **⌘K (Ctrl K hors Mac), ou « Aller à, lancer » en haut à gauche** : une recherche pour aller à n'importe quel fil (À toi, Conversation, Historique, objectifs, groupes, tâches dev), à une rubrique des Réglages, ou lancer une action (nouvelle conversation, tâche dev, comparaison, objectif, équipe, dictée, tour de veille, raccourcis). Les commandes perso y sont aussi : choisir `/relances` la met dans le champ. Flèches, Entrée, Échap (une fois pour vider la recherche, une fois pour fermer) ; le focus revient où il était.
- Liens directs : `#activite`, `#objectif/3`, `#dev/12`, `#groupe/2`, `#reglages/connexions`…

Les comportements délicats de l'interface viennent de **ui-sdk** (Vercel Labs, en bêta), dans sa version Web Components, servie par Clark sous `/ui/` (la CSP reste `'self'` ; une balise `csp-nonce` sans nonce lui fait utiliser des feuilles de style construites) :
- la liste des commandes `/` dans le champ de message : un vrai combobox, flèches pour choisir, Entrée pour compléter (sans envoyer), Échap pour fermer, annoncé aux lecteurs d'écran ;
- les confirmations (jeter, supprimer, nouvelle conversation…) : une fenêtre d'alerte modale, focus sur Annuler, Échap pour annuler.
Le skill `ui-sdk` est installé dans `~/.claude/skills` : les agents de Dev le lisent quand une tâche touche une interface.

Sur téléphone, la barre de gauche s'ouvre par-dessus (bouton ☰), et les rubriques des réglages défilent en haut.

## Dev : agents de code dans des copies isolées

Le mode **Tâche dev** du composeur (projets dans Réglages › Projets dev) fait travailler des agents de code sur tes dépôts, façon Orca, mais dans Clark.
- **Projets** : un dépôt git (sa racine), sa branche de base (détectée par défaut) et, si tu veux, sa commande de test.
- **Nouvelle tâche** : une consigne et un moteur (Claude, Codex ou le principal). Clark crée une **copie isolée** du dépôt (un worktree git, sur une branche `clark/…`, rangé dans `workspace/dev/`), puis un agent y travaille. Il ne modifie que cette copie, dans le bac à sable (pas de réseau, pas d'installation), et ne touche pas à git : c'est Clark qui s'en occupe. Ta branche et ton dossier de travail ne bougent pas.
- **Relecture** : quand l'agent a fini, un message arrive dans la conversation et la tâche apparaît dans « À toi ». Son détail montre son résumé, les fichiers changés (A/M/D, +/−) et le **diff** en couleurs.
  - **Lancer les tests** : la commande du projet, dans la copie, sur ton clic seulement (hors du bac à sable, car les tests ont souvent besoin du réseau ; les `node_modules` du dépôt sont reliés à la copie s'ils manquent). Résultat et sortie dans la carte.
  - **Retoucher** : une consigne de plus ; le même agent reprend dans la même copie, avec sa session.
  - **Accepter** : tout devient un commit sur la branche `clark/…`, la copie est retirée, la branche reste. Tu la fusionnes (ou ouvres une PR) quand tu veux. Les crochets git (hooks) du dépôt ne tournent pas, pour qu'un crochet modifié par l'agent ne s'exécute jamais.
  - **Jeter** : la copie et sa branche sont supprimées.
- Les demandes d'accord d'une tâche dev sont marquées « Tâche dev #n ». Après un redémarrage, un tour fini pendant la coupure est relu.

**Plusieurs agents en parallèle.** Mode **Dev en parallèle** dans le composeur :
- un agent de plan lit le projet (en lecture seule, dans sa propre copie) et découpe la consigne en 1 à 5 sous-tâches. Celles qui sont indépendantes touchent des fichiers différents et tournent en même temps ; s'il en prévoit sur les mêmes fichiers, la carte te prévient ;
- **dépendances** : une sous-tâche qui a besoin du résultat d'une autre (la page après l'API) reste **en attente** jusqu'à ce que tu aies accepté celles dont elle dépend. Sa copie part alors de leur travail (leurs branches fusionnées dans la sienne) et son diff ne montre que ce qu'elle ajoute. Si l'une d'elles est jetée, elle s'arrête ; « Réessayer » la relance sans ;
- **décisions** : si un choix change vraiment le travail, le plan te le pose (2 à 4 options, ou ta réponse à toi) dans « À toi » et sur la carte du groupe. Les sous-tâches concernées attendent ta réponse, qui est ajoutée à leur consigne ; les autres avancent ;
- les sous-tâches tournent en même temps, chacune dans sa copie et sur sa branche, **2 agents à la fois au plus** (`CLARK_DEV_PARALLEL` pour changer) ; les autres attendent un agent libre ;
- tu relis, retouches, acceptes ou jettes chaque sous-tâche comme une tâche seule ;
- **Réessayer de zéro** (tâche à relire ou arrêtée) : copie et branche neuves, conversation neuve, avec le moteur, le modèle et l'effort que tu choisis pour cette tâche seulement. L'ancienne copie et sa branche sont supprimées ;
- **Réunir** : Clark fusionne les sous-tâches acceptées sur une nouvelle branche `clark/…` (sans crochets). Au moindre conflit, tout est annulé et la carte nomme les fichiers en cause : rien n'est laissé à moitié.

**Relire le diff.** Lignes numérotées des deux côtés, liste des fichiers cliquable, retour à la ligne au choix, et au clavier : `j`/`k` fichier suivant/précédent, `n`/`p` changement suivant/précédent, `c` commenter la ligne.
- **Commenter des lignes** : le `+` au bord d'une ligne (ou `c`), Maj+clic sur une autre ligne pour étendre la plage, Entrée pour enregistrer. Les commentaires restent posés sur leurs lignes (retrouvées par leur texte si le diff a bougé ; sinon listés sous le diff).
- **Envoyer N commentaires à l'agent** : un seul tour, une consigne qui donne pour chacun le fichier, les lignes, l'extrait et ton commentaire. Après sa retouche, tu vérifies, puis **Résoudre**. Un commentaire encore ouvert repart au lot suivant (« déjà demandé ») ; un commentaire pas encore envoyé se retire.

**Partir d'une issue GitHub.** Réglages › Projets dev › **Issues GitHub** : les issues ouvertes du dépôt (via `gh`), et pour chacune **Tâche dev** ou **En parallèle**. Ou, en mode Tâche dev, tape `#12` (suivi de précisions si tu veux). La consigne reprend l'issue, présentée à l'agent comme de la donnée ; la PR contiendra « Closes #12 ».

**Suivre la PR.** Une fois la PR ouverte, Clark la relit toutes les 3 minutes (`CLARK_PR_POLL_MINUTES`) par `gh` : état (ouverte, mergée, fermée), CI (jobs réussis, en cours, en échec, avec leur lien), décision de review, commentaires (y compris sur des lignes). Il te prévient dans la conversation (donc sur Telegram ou iMessage) quand la CI casse ou repasse au vert, quand des commentaires arrivent, quand la PR est approuvée, mergée ou fermée.
- **Corriger la CI** : une tâche de suivi sur la branche même de la PR, dont la consigne contient les journaux des jobs en échec (`gh run view --log-failed`, présentés comme de la donnée).
- **Traiter les commentaires** : pareil, avec les commentaires de review.
- Tu relis cette tâche comme une autre ; **Accepter et mettre à jour la PR** fait le commit et l'envoie sur la branche (jamais en forçant ; si GitHub a avancé, Clark le dit). La jeter ne supprime jamais la branche de la PR. Une seule tâche de suivi ouverte à la fois par PR.

**Points de reprise.** Après chaque tour de l'agent, Clark garde l'état de la copie (fichiers suivis et nouveaux, hors fichiers ignorés) dans un commit à part, attaché à `refs/clark/dev/<tâche>/tour-<n>` : ni la branche ni l'index ne bougent. Dans « Tours de l'agent », **Revenir à ce tour** remet la copie, le diff et le résumé dans l'état de ce tour ; les autres tours restent disponibles (on peut revenir en avant). À la retouche suivante, l'agent est prévenu que les tours d'après sont annulés. Accepter, jeter ou réessayer la tâche efface ses points de reprise.

**Comparer deux agents.** Dans le composeur, « Comparer deux agents » : la même consigne part à deux agents, chacun dans sa copie et sur sa branche (Claude et Codex, ou un même moteur à effort moyen et élevé). Depuis une tâche seule déjà faite, « Comparer avec un autre agent » lance la deuxième version (moteur, modèle, effort au choix). Une seule note quand les deux ont fini. La page de chaque version montre les deux côte à côte (qui, état, fichiers et lignes, tests, résumé) et les fichiers touchés par les deux ou par un seul. **Garder celle-ci** accepte cette version (commit sur sa branche) et jette l'autre ; si l'autre travaille encore, son agent est d'abord arrêté.

**Mode design (aperçu).** Sur une tâche dev à relire, **Aperçu** montre la copie dans Clark, à la largeur choisie (ordinateur, tablette, mobile) :
- sans réglage, les fichiers de la copie (`index.html`, ou la page indiquée dans Réglages › Projets dev) ;
- avec une commande de serveur de dev (par exemple `npm run dev -- --port $PORT`), Clark la lance dans la copie et relaie ses pages ; elle s'arrête à la fermeture de l'aperçu.

L'aperçu vient d'un port à part (`CLARK_PREVIEW_PORT`, 4320 par défaut ; 4321 pour la démo) : le code du site ne peut rien demander à Clark, et ni `.git`, ni `.env`, ni rien hors de la copie n'est servi. **Choisir un élément**, puis un clic dans l'aperçu : son HTML, ses styles calculés et sa capture (prise par Chrome sans fenêtre) sont joints à la retouche suivante, présentés à l'agent comme de la donnée, la capture en vraie image (Claude et Codex). Accepter ou jeter la tâche ferme l'aperçu et efface ses captures (`data/design/`).

**Agent silencieux.** Une tâche qui tourne sans la moindre activité (étape, point d'étape) depuis 10 minutes (`CLARK_STALL_MINUTES`) est signalée une fois, dans la conversation et dans « À toi » ; une tâche qui attend ton accord ou ta réponse ne compte pas. **Arrêter l'agent** interrompt son tour (Claude : la requête est annulée ; Codex : le tour est interrompu). Une écriture en cours reste « à vérifier », rien n'est refait sans toi. Le bouton existe aussi sur toute tâche dev en cours.

**Pull request.** Sur une tâche acceptée ou un groupe réuni : **Ouvrir une pull request**. Le titre et le texte sont préremplis (consigne, résumé de l'agent, sous-tâches) ; tu les relis et les modifies, puis **Ouvrir la PR** : Clark envoie la branche sur `origin` (sans crochets) et lance `gh pr create` vers la branche de base. Il faut un dépôt distant `origin` et `gh` connecté (`gh auth login`). Une seule PR par tâche ou groupe ; le lien s'affiche dans la carte et dans la conversation.

## Réglages

**Général.** Les réglages qui étaient seulement dans `.env` se changent dans Réglages › Général : tour de veille, brief du matin, agents de code en même temps, seuil d'agent silencieux, relecture des PR, moteur principal, moteur par rôle, dépenses (clé API), bac à sable. La valeur choisie ici passe devant `.env` (stockée dans la base) ; « revenir à … » rend la main à `.env`. La plupart s'appliquent tout de suite ; ceux marqués « au prochain redémarrage » attendent `scripts/service.sh restart`. **Aucun secret** ici : clés et jetons restent dans `.env`. Apparence : thème clair, sombre ou comme le système (gardé sur l'appareil). Une recherche en haut des réglages (`⌘,`) parcourt toutes les rubriques ; `?` liste les raccourcis.

**Notifications.** Tout reste dans la conversation et dans « À toi » ; Réglages › Notifications choisit ce qui part en plus et où (Telegram, iMessage, notifications du navigateur), par genre : réponses, accords et questions, tâches dev, pull requests, agents silencieux, propositions du tour de veille, autres notes. Par défaut : tout sur Telegram ; réponses et accords sur iMessage et le navigateur. **Heures calmes** (ex. 23:00 → 08:00) : rien ne part, sauf les accords si tu le gardes coché ; à la fin, un seul message résume ce qui a été retenu. **Garder le Mac éveillé** (`caffeinate`) : pendant qu'un agent travaille (par défaut), toujours, ou jamais. Fermer l'écran le met quand même en veille.

**Réglages par projet** (Réglages › Projets dev › Réglages du projet) : moteur, modèle et effort par défaut de ses tâches (et de ses groupes) ; commande de test ; **commande de préparation** lancée dans chaque nouvelle copie avant l'agent (ex. `npm ci`, hors du bac à sable, 10 min au plus ; si elle crée des fichiers suivis par git, la carte le signale) ; **fichiers à copier** dans chaque copie : seulement des fichiers ignorés par git, et jamais un secret (`.env`, clés, identifiants sont refusés, car l'agent lit sa copie).

**Sauvegarde** (Réglages › Sauvegarde). **Exporter** : un fichier JSON avec réglages, notifications, personnalité, voix, choix de modèles, commandes, automatisations, serveurs MCP (noms de variables seulement), plugins (leurs adresses) et projets ; la mémoire en option. Jamais de secret ni de connexion. **Importer** : aperçu de ce qui serait ajouté ou remplacé ; ce qui existe déjà reste tel quel ; la personnalité et la mémoire sur ton choix ; les projets dont le dossier n'existe pas sont laissés de côté ; les plugins ne sont jamais installés d'office, tu les relis un par un. C'est le chemin pour passer sur le VPS.

## Personnalité et voix

**Personnalité** (Réglages › Personnalité et voix) : un texte que tu écris, enregistré dans `personnalite.md` à la racine. Il règle le ton de Clark (humour, manières, ce qu'il évite). Il est placé sous les règles fixes du prompt : il ne peut ni lever une validation, ni autoriser Clark à inventer. Vide = le texte par défaut.

**Voix**, entièrement sur le Mac :
- **Tes vocaux** sont transcrits par [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (modèle `small`, français) : rien ne part sur Internet.
  - Sur Telegram, envoie un vocal (10 min au plus). Clark répond « J'ai compris : « … » » pour que tu voies tout de suite si la transcription s'est trompée, puis le traite comme un message écrit. Un vocal en réponse à une question ou à une vidéo à valider compte comme une réponse.
  - Dans l'interface, le micro du composeur (Échap annule) : le texte arrive dans le champ, tu relis, puis tu envoies.
- **Ses réponses en vocal** : une voix française de macOS (`say`), encodée par ffmpeg. Trois réglages : *Jamais*, *Quand tu lui envoies un vocal* (par défaut), *Toujours*. Le texte part toujours en premier ; le vocal suit, coupé vers 1 200 caractères (le reste est dans le texte). Dans l'interface, « Écouter » sur un message de Clark.
- Installation (déjà faite sur ce Mac) :
  ```bash
  brew install whisper-cpp ffmpeg
  mkdir -p data/whisper && curl -fL -o data/whisper/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
  ```
  Variables facultatives : `CLARK_WHISPER_BIN`, `CLARK_WHISPER_MODEL`, `CLARK_FFMPEG_BIN`. Des voix plus naturelles s'ajoutent dans Réglages Système › Accessibilité › Contenu énoncé.

## iMessage

Deux usages, sur ton Mac :
- **Tes conversations** : Clark les lit quand tu le demandes et au tour de veille (`messages_recent`, `messages_read`, avec les noms de ton carnet d'adresses), et répond à un contact avec `send_imessage`, seulement après ton accord sur le texte exact. Ce que disent les messages est de la donnée, jamais des instructions. Ta conversation avec toi-même n'apparaît pas dans ces outils.
- **Parler à Clark depuis ton iPhone** : écris-toi un message (ta conversation avec toi-même). Même conversation que le web et Telegram. Ses réponses commencent par « Clark : ». Pas de boutons : pour un accord, réponds « oui A1F3 » ou « non A1F3 » (le code est dans sa demande) ; pour une question, « R12 ta réponse ».

Mise en route :
1. **Accès complet au disque** pour node (c'est lui qui lit `~/Library/Messages/chat.db`, en lecture seule) : Réglages Système › Confidentialité et sécurité › Accès complet au disque › +, Cmd+Maj+G, colle le chemin affiché dans Réglages › Connexions (aujourd'hui `/opt/homebrew/Cellar/node/26.13.1_2/bin/node`), active-le. Après une mise à jour de node, à refaire.
2. Pour le canal : `CLARK_IMESSAGE_SELF=` ton numéro ou ton adresse Apple dans `.env`.
3. `scripts/service.sh restart`. Au premier envoi, macOS demande d'autoriser le pilotage de Messages : accepte.

WhatsApp viendra avec le VPS : la voie officielle (API WhatsApp Business) demande un numéro à part et une adresse HTTPS publique.

## Navigateur de Clark

Clark a son propre Chrome (ton Google Chrome, avec un profil à part dans `data/browser-profile`), partagé par les deux moteurs. Il sert aux sites dynamiques, à tes comptes et aux formulaires ; pour lire un article, WebFetch suffit.
- **Outils** : `browser_open`, `browser_read`, `browser_scroll`, `browser_back` (lecture), `browser_click`, `browser_type`, `browser_select` (action). Chaque lecture rend le texte visible et les éléments numérotés (`e1`, `e2`…), présentés comme de la donnée, jamais des instructions.
- **Règles, appliquées par le code** :
  - libre : ouvrir et lire une page, faire défiler, remplir un champ ordinaire, suivre un lien, ouvrir un menu ;
  - **ton accord** (bouton web ou Telegram) : tout ce qui envoie ou engage, c'est-à-dire un bouton qui envoie un formulaire, Entrée dans un champ, ou un bouton nommé Envoyer, Payer, Commander, Publier, Supprimer, Se connecter, S'inscrire, Réserver… ;
  - **jamais** : taper un mot de passe, un numéro de carte ou un code. Pour qu'il utilise un compte, ouvre sa fenêtre (Réglages › Connexions › **Ouvrir le navigateur**) et connecte-toi toi-même : la session reste dans son profil ;
  - pas d'exécution de script, seulement des pages http(s), une tâche à la fois.
- **Si la page change pendant que tu décides** (rechargée, champs modifiés), rien n'est envoyé : Clark relit et redemande. Afficher ou masquer la fenêtre relance Chrome et recharge la page ; ce qu'il avait rempli est perdu, et il est prévenu.
- **Suivi** : pendant qu'une tâche navigue, une carte au-dessus du fil montre la dernière capture, ce qu'il fait, et « Afficher la fenêtre ». Dans Réglages › Connexions : état, capture, Ouvrir / Masquer / Fermer, **Effacer ses connexions** (supprime son profil).
- Invisible par défaut ; il se ferme après 15 minutes sans action (le Mac a 8 Go), sauf s'il est affiché.
- Codex y accède par l'adresse interne de Clark (`/internal/browser`), avec un jeton tiré à chaque démarrage et écrit seulement dans `data/codex-home/config.toml` (lisible par toi seul).
- Variables facultatives : `CLARK_BROWSER_EXECUTABLE` (autre Chrome), `CLARK_BROWSER_PROFILE`.
- Démo : « Remplis le formulaire de contact sur le site de Studio Pixel » pilote le vrai Chrome (profil jetable) sur un site fictif local, jusqu'à ta validation.

## Gérer les conversations

Dans la barre de gauche, le bouton **⋯** d'une conversation (au survol, ou au clavier) : **Renommer** (le nom reste ensuite), **Épingler en haut** (section « Épinglées »), **Supprimer…** (avec confirmation : ses messages sont effacés pour de bon, les tâches restent dans Activité ; refusé tant que Clark y répond). Les agents de « Équipe » ont le même menu pour leur dernière conversation. « Plus anciennes » se trie par activité récente, date de création ou nom (gardé sur l'appareil).

## Terminal

Icône Terminal dans la colonne de gauche (`#terminal`), **sur le Mac seulement** : rien de tout ça ne passe par Telegram.
- **Tes commandes** : tape et Entrée ; elles tournent dans ton shell (zsh, avec ton `.zprofile`), dans le dossier affiché (`~/Developer` au départ). `cd` change de dossier, ↑/↓ rappellent les commandes précédentes, **Arrêter** coupe la commande et tout ce qu'elle a lancé, `clear` ou **Effacer** vide l'écran.
- **Celles de Clark** : avec l'outil `run_command`, il propose une commande exacte, son dossier et pourquoi. Une carte « Clark propose » s'affiche ici (pastille sur l'icône, note dans le fil et sur Telegram pour prévenir) ; elle ne tourne que si tu cliques **Lancer** dans l'interface du Mac. Clark lit ensuite le code de sortie et la fin de la sortie. 30 minutes pour décider, 10 minutes d'exécution au plus ; pas de `sudo`.
- **Limites** : une commande à la fois, sans saisie au clavier (pas de vim, de mot de passe ni de programme interactif), sans couleurs. Le shell ne reçoit pas les secrets de Clark (`.env`).
- **Sécurité** : les routes vérifient l'hôte et l'origine (une page web ne peut rien lancer) ; une demande d'avant un redémarrage expire.

## Mode objectif

Sous le champ de la conversation, choisis **Objectif** (ou `/objectif …` sur Telegram) : Clark enchaîne les tours jusqu'à atteindre le but. L'idée vient de Spettro.
- Chaque objectif a sa propre conversation : les tours se suivent avec leur contexte, sans encombrer la tienne. Tu suis chacun dans la barre de gauche (Récents) et son détail : tour en cours, dernier compte rendu, prochaine étape, journal des tours.
- À la fin de chaque tour, l'agent fait un compte rendu (`report_goal`) : avancée, objectif atteint, ou blocage avec une question pour toi.
- Clark s'arrête et attend ta réponse s'il est bloqué, s'il tourne en rond (deux tours qui disent la même chose, ou deux tours sans compte rendu), si le quota dépasse 90 %, si un tour échoue ou est coupé en pleine écriture, ou à la limite de tours (10 par défaut, 30 au plus). Tu réponds dans la carte et tu cliques sur **Reprendre** : ta réponse part avec le tour suivant. Reprendre après la limite ajoute cinq tours.
- **Mettre en pause** et **Arrêter** à tout moment. Les actions à effet passent toujours par ton accord ; les demandes d'un objectif sont marquées « Objectif #n ».
- Objectif atteint ou en attente : un message arrive dans ta conversation (et sur Telegram). Après un redémarrage, les objectifs actifs reprennent seuls.

## Skills et commandes perso

**Skills** : tes méthodes (copywriting, design…), au format de Claude Code. Clark lit `skills/` (les siens) et `~/.claude/skills` (les tiens), en lecture seule. Il voit la liste dans sa consigne et lit un skill en entier quand une demande correspond (outil `use_skill`), sans jamais sortir du dossier du skill. La liste est dans **Réglages › Skills**.

**Commandes** : des consignes que tu relances souvent, rangées dans `commands/<nom>.md` (description, mode `chat`, `team` ou `goal`, puis la consigne ; `$ARGUMENTS` est remplacé par ce que tu écris après la commande). Tape `/` dans la conversation pour les voir (Tab complète), ou `/nom …` sur Telegram. Dans **Réglages › Commandes** : les lancer, les créer, les supprimer. Exemple fourni : `/mails`.

## Plugins

Réglages › Plugins : un paquet de **commandes**, de **skills** et de **serveurs MCP**, au format des plugins Claude Code (`.claude-plugin/plugin.json`, `commands/*.md`, `skills/<nom>/SKILL.md`, `.mcp.json`). Les plugins Claude Code existants s'installent donc tels quels.

1. **Ajouter** : une adresse git en https (sans identifiants) ou un dossier de ton Mac, et si besoin le sous-dossier du plugin. Un dépôt **catalogue** (`marketplace.json`, par exemple `https://github.com/anthropics/claude-plugins-official`, 317 plugins) affiche sa liste avec une recherche : « Relire » sur celui que tu veux, y compris ceux hébergés ailleurs et épinglés à une version. Ceux qui s'installent en lançant une commande ne sont pas pris en charge.
2. **Relire** : Clark récupère le paquet à part (clone sans crochets git ni sous-modules, liens symboliques ignorés, 20 Mo au plus) et montre tout :
   - chaque commande et la consigne exacte qu'elle envoie (renommée `plugin-nom` si le nom est déjà pris ou réservé). Les `!`git status`` des plugins Claude Code ne sont pas lancés d'avance : l'agent les voit comme « à obtenir toi-même » et les lance avec ton accord. `allowed-tools` est ignoré : les règles de Clark s'appliquent. `$ARGUMENTS`, `$1`, `$2`… sont remplacés ;
   - chaque skill, son SKILL.md et ses autres fichiers, les scripts signalés (Clark ne les lance jamais lui-même) ;
   - chaque serveur MCP, avec la commande exacte qu'il lancera sur ton Mac et les variables à mettre dans `.env` (une valeur écrite en clair dans le plugin est ignorée) ;
   - les autres fichiers du paquet (code annexe, exemples), copiés mais jamais lancés ;
   - ce qui n'est pas repris : **crochets (hooks)** et **agents** (ils exécuteraient du code ou changeraient les règles hors des accords de Clark), styles de réponse, serveurs LSP.
3. **Installer** : exactement la version relue, copiée dans `data/plugins/<nom>` (sans `.git`). Ses serveurs MCP démarrent en confiance « demander » : chaque appel attend ton accord.
4. Ensuite : **Couper / Activer**, **Vérifier une mise à jour** (relecture de la nouvelle version avec la liste des fichiers ajoutés, modifiés, supprimés), **Désinstaller** (commandes, skills, serveurs et dossier retirés).

À nom égal, ton skill ou ta commande passe avant celui d'un plugin. L'index (`data/plugins/index.json`) est lu aussi par le serveur MCP de Codex. Variable facultative : `CLARK_PLUGINS_DIR`.

## Bac à sable des commandes

Les commandes shell de Clark sont confinées, quel que soit le moteur, par un réglage que le modèle ne voit pas et ne peut pas changer. L'idée vient de Spettro.
- Codex : profils de permissions (voir « Moteur Codex »).
- Claude : Seatbelt (macOS). Lecture et écriture dans le dossier de travail et la mémoire cœur seulement (plus le dossier temporaire en écriture) ; le reste de ton dossier personnel est fermé, `.env` et `data/` compris ; pas de réseau. Il échoue fermé : s'il ne démarre pas, la commande ne tourne pas. La validation par bouton reste en plus.
- Réglages › Général › Sécurité (ou `CLARK_SANDBOX=off` dans `.env`) le coupe pour Claude (dépannage seulement). L'état est affiché dans **Réglages › Connexions**.

## Serveurs MCP ajoutés

Dans **Réglages › Serveurs MCP**, **Ajouter un serveur MCP** branche un serveur de plus (Notion, Drive, un outil maison…), donné aux deux moteurs :
- **Commande lancée sur ce Mac** (ex. `npx` et ses arguments, un par ligne) ou **adresse web** en https.
- **Variables d'environnement** : seulement leurs **noms**. Tu mets les valeurs toi-même dans `.env`, puis tu redémarres Clark (`scripts/service.sh restart`). Les valeurs ne passent jamais par l'interface ni par la base. Le serveur ne reçoit que les variables qu'il a déclarées, pas les autres secrets de Clark. La carte dit si chaque variable est renseignée dans `.env`, sans montrer la valeur.
- **Appels de ses outils** : par défaut, **chaque appel te demande ton accord** (carte dans la conversation et sur Telegram, avec le contenu de l'appel) ; les agents en lecture seule ne peuvent pas les utiliser. Si tu sais que ses outils ne font que lire, déclare-le « en lecture seule » : ils passent sans demander, y compris pour les agents en lecture seule.

À l'ajout, Clark **teste** le serveur : il le lance et liste ses outils, sans en appeler aucun. Chaque carte a **Tester**, **Couper**/**Activer**, le changement de confiance et **Supprimer**. Un changement vaut pour les tâches suivantes.

Côté Codex, les serveurs sont passés à chaque fil, sans redémarrer Codex, et les secrets par leur nom (`env_vars`, `bearer_token_env_var`). Quand Codex demande l'accord pour un outil, Clark te le transmet et ne répond que « Allow » (cet appel) ou « Cancel », jamais « pour la session » ni « toujours ».

## Démarrer (MVP, sur le Mac)

Il faut Node 24 ou plus récent : le TypeScript tourne directement, sans étape de build.

```bash
npm install
```

Crée un fichier `.env` à la racine avec ces lignes, et remplis-le toi-même :

```
CLARK_ENGINE=                 # codex ou claude ; vide = claude si une clé API est là, sinon codex
CLARK_CODEX_MODEL=            # facultatif : modèle Codex (vide = celui par défaut)
CLARK_ROLE_ENGINES=           # facultatif : moteur par rôle, ex. redacteur=codex,relecteur=claude
ANTHROPIC_API_KEY=            # console.anthropic.com (moteur Claude seulement)
TELEGRAM_BOT_TOKEN=           # facultatif : donné par @BotFather
TELEGRAM_OWNER_ID=            # facultatif : ton id numérique, via @userinfobot
CLARK_WEB_PORT=4310           # port de l'interface
CLARK_MODEL=claude-opus-5-5
CLARK_MAX_USD_PER_TASK=1      # plafond par tâche
CLARK_MAX_USD_PER_DAY=5       # plafond par jour
CLARK_BRIEF_HOUR=8            # vide = pas de brief du matin
CLARK_HEARTBEAT_MINUTES=120   # tour de veille ; 0 = coupé
GOOGLE_CLIENT_ID=             # facultatif : Gmail + Google Agenda (voir « Mail et agenda »)
GOOGLE_CLIENT_SECRET=
```

**Connecter ton compte Claude**, une seule fois. Clark a son propre dossier Claude (`data/claude-home`), séparé de ton `~/.claude` : ni tes réglages, ni tes hooks, ni tes plugins ne sont chargés.

```bash
CLAUDE_CONFIG_DIR="$PWD/data/claude-home" claude auth login
```

La connexion passe par le flux officiel d'Anthropic : Clark ne lit, ne copie et ne stocke jamais d'identifiant. Anthropic prévoit l'« usage ordinaire et individuel » de Claude Code et de l'Agent SDK avec un abonnement Pro, Max ou Ultra (code.claude.com/docs/en/legal-and-compliance). Clark est ton outil personnel, garde-le dans cet usage : une automatisation toutes les heures avec une équipe de quatre agents use vite les limites de ton forfait. Avec l'abonnement, les plafonds en dollars ne s'appliquent pas, et c'est la limite de ton forfait qui compte.

Avec Codex, connecte Clark à ChatGPT une seule fois. Il a son propre dossier Codex, `data/codex-home`, séparé de ton `~/.codex` :

```bash
CODEX_HOME="$PWD/data/codex-home" codex login
```

Ensuite :

```bash
npm start
```

Ouvre **http://localhost:4310**. On y trouve :
- la conversation ;
- les demandes de validation, avec la commande exacte ;
- les tâches en cours, étape par étape ;
- les tâches à vérifier ;
- la dépense du jour et la mémoire.

Dans le chat privé Telegram (si configuré), `/taches` affiche les tâches en file ou en cours, l'avancement des agents et les boutons des tâches à vérifier. Les autres commandes sont `/nouveau`, `/memoire`, `/budget` et `/equipe`.

Pour voir l'interface sans clé API, lance `npm run demo` puis ouvre http://localhost:4311. Elle tourne avec un faux agent et des données fictives : rien n'est réellement lu ni écrit. Sa base (`data/demo.db`) survit à un redémarrage. Pour repartir de zéro : `npm run demo -- --reset`.

## La commande `clark`

`npm run cli:install` relie `bin/clark.mjs` à `~/.local/bin/clark` (déjà fait sur ce Mac). Elle parle à Clark par son interface locale :

```bash
clark "rappelle-moi de relancer Julie jeudi"     # un message ; --attendre pour la réponse
clark envoie "prépare les relances" --equipe     # ou --objectif
clark dev portfolio "corrige le menu mobile"     # une tâche dev ; --parallele, --moteur codex, --attendre
clark dev portfolio "#12"                         # depuis l'issue GitHub #12
clark taches                                      # ce qui tourne, ce qui t'attend
clark attendre dev 42                             # jusqu'à ce que la tâche soit à relire
clark etat                                        # moteur, quota, ce qui t'attend
clark export --memoire -o clark.json              # la configuration, sans secrets
```

`--json` donne une sortie pour un script ou un autre agent (tes sessions Claude Code peuvent confier une tâche à Clark). Les messages venus du terminal portent « · terminal » dans la conversation.

**Pas d'accords par la commande** : elle ne valide rien et ne répond à aucune question ; ça reste sur les boutons (web, Telegram) ou par code (iMessage). À savoir : l'interface locale reste joignable par tout programme lancé sous ton compte sur ce Mac, comme avant ; les agents de Clark, eux, n'y ont pas accès (bac à sable sans réseau).

## Architecture

```
src/
├── index.ts              assemble tout, arrêt propre
├── config.ts             .env et chemins
├── memory/store.ts       SQLite : souvenirs (FTS5), sessions, dépenses, audit
├── memory/tools.ts       outils MCP propose_memory / recall / propose_correction / forget
├── core/prompt.ts        identité, North Stars, mémoire cœur, top souvenirs
├── core/agent.ts         moteur Claude : un tour d'agent (Agent SDK), budget, reprise
├── engines/codex.ts      moteur Codex : fil, étapes, validations via le Codex App Server
├── engines/codex-app-server.ts  client JSON-RPC du Codex App Server
├── memory/mcp-server.ts  outils de mémoire en serveur MCP séparé, pour Codex
├── core/hub.ts           cœur commun aux canaux : file, validations, alertes, reprise
├── core/team.ts          équipe d'agents : exécution du plan, tentatives, équipe habituelle
├── core/plan.ts          plan d'équipe : catalogue, spécialistes temporaires, dépendances
├── social/               réseaux sociaux : montage vertical (ffmpeg + text-card.swift), brouillons, règles par plateforme
├── core/conversation.ts  fil de la conversation (durable, affiché par l'interface)
├── policy/permissions.ts 3 niveaux : auto / dossier de Clark / validation par bouton
├── gateway/web.ts        serveur local : état en direct (SSE) et actions
├── gateway/telegram.ts   canal Telegram facultatif, même conversation
├── web/                  l'interface : HTML, CSS, JS, sans build
├── tasks/journal.ts      journal durable des tâches et de leurs étapes
└── scheduler/cron.ts     brief du matin (une fois par jour)
scripts/demo.ts  démo de l'interface avec un faux agent
recette/     notes fictives et procédure de test des coupures (RECETTE.md)
memory/      mémoire cœur en Markdown, c'est toi qui l'écris (profil.md, hors de git : pars de docs/profil.exemple.md)
workspace/   le seul dossier où Clark écrit librement
data/        clark.db, le fichier à sauvegarder
```

**Sécurité.** L'interface n'écoute que sur 127.0.0.1. Elle refuse un en-tête Host étranger, ce qui bloque le DNS rebinding. Elle refuse aussi toute écriture venue d'une autre origine : une page web ouverte ailleurs ne peut ni écrire à Clark ni valider à ta place. Sur Telegram, Clark ne répond qu'à `TELEGRAM_OWNER_ID`. Ce qui passe sans validation :
- la mémoire ;
- la recherche web ;
- les fichiers, dans `workspace/` et `memory/` seulement.

Tout le reste te demande une validation par bouton, dans l'interface ou sur Telegram (refus automatique après 10 minutes). Le shell en fait partie, tout comme les fichiers hors de ces dossiers. Chaque appel d'outil est inscrit dans la table `audit`. Clark n'hérite pas de ta config Claude Code perso (`settingSources: []`).

## Moteurs : quotas, modèles, puissance

**Réglages › Moteurs** (et, pour le moteur principal, la puce du composeur) montre, pour Claude et pour Codex :
- **le quota de ton abonnement** : fenêtres de 5 h et de 7 jours, pourcentage utilisé, heure de remise à zéro. Clark lit ce que disent Claude Code (comme `/usage`) et Codex, sans envoyer de message au modèle, donc sans rien consommer. Relu au démarrage, tous les quarts d'heure et avec « Actualiser ». Si une tâche Claude bute sur la limite, c'est noté tout de suite. Côté Claude, l'usage passe par une API que le SDK marque comme expérimentale : si elle change, le quota s'affiche « pas encore donné », le reste marche ;
- **le modèle** (un menu) et **l’effort** (niveau de raisonnement, un curseur à crans : « Auto » puis les niveaux du modèle, « Recommandé » sous celui que le moteur conseille), remplis avec ce que chaque moteur propose à ton compte, jamais une liste écrite en dur. Un choix impossible (une puissance qu'un modèle n'a pas) est refusé.

Le choix est rangé dans la base : il survit au redémarrage et vaut pour toutes les tâches suivantes (conversation, équipe, tour de veille, brief). Les tâches en cours gardent le leur. « Par défaut » reprend `CLARK_MODEL` / `CLARK_CODEX_MODEL`, sinon le défaut du moteur. Plus de puissance : des réponses plus réfléchies, plus lentes, et plus de quota consommé.

## Moteur Codex

Clark lance `codex app-server` avec son propre dossier de configuration (`data/codex-home`). **Rien de ta config Codex perso n'est chargé** : ni plugins, ni computer use, ni connecteurs comme Slack, ni hooks, ni mémoire Codex. Ses seuls outils en plus sont ceux de sa mémoire confirmée.

Le cadre est fixé par Clark à chaque tour, avec deux profils de permissions du bac à sable de Codex (seatbelt sous macOS) :
- **`clark`** : `workspace/` et `memory/` en écriture ;
- **`clark-read`** : les mêmes en lecture seule, pour le Chercheur, le Relecteur et la vérification avant reprise.

Dans les deux profils, **ton dossier personnel est fermé** en dehors de ces deux dossiers. Le `.env` de Clark, sa base, ses dossiers de connexion et tes autres projets (le `.env.local` de ton portfolio, par exemple) sont illisibles pour les commandes de Codex. Les outils du système (ffmpeg, node…) restent utilisables, et il n'y a pas de réseau.

C'est vérifié en vrai avec `codex sandbox`. Le choix du profil à chaque tour passe par l'API expérimentale de l'App Server : à revérifier après une mise à jour de Codex.

**Validation** : toute commande qui n'est pas une simple lecture te demande ton accord, comme une modification de fichier hors de ses dossiers. Si Codex demande à sortir du bac à sable pour une commande, tu le vois dans la carte, et refuser reste le bon réflexe.

Une demande d'élargissement de permissions est refusée d'office.

**Quota.** Avec Codex, le bloc « Quota Codex » remplace la dépense du jour. Il affiche, pour chaque fenêtre de ton abonnement (par exemple 5 h et 7 jours), la part utilisée et l'heure de remise à zéro. Les chiffres viennent de Codex : Clark les lit au démarrage, les suit pendant chaque tour et les relit après, sans rien estimer lui-même.
- **Fenêtre utilisée à 90 % ou plus** : Clark te prévient avant de lancer une équipe, puis la lance quand même.
- **Limite atteinte** : avant de refuser, il relit une fois le quota auprès de Codex.
  - Si les chiffres frais disent encore « atteint », il refuse en précisant qu'il vient de revérifier, avec l'heure de remise à zéro.
  - Si Codex ne répond pas et que la remise à zéro annoncée n'est pas passée, il refuse aussi. Le message dit alors que le quota n'a pas pu être revérifié, et à quelle heure date la dernière lecture.
- **Remise à zéro annoncée déjà passée** : il relit aussi le quota avant de décider. Un ancien « épuisé » ne bloque donc jamais après la remise à zéro. Si la relecture échoue, il lance l'équipe et te le signale.

Pour voir ces cas dans la démo : `CLARK_DEMO_QUOTA=95 npm run demo`, ou `100` pour une limite atteinte.

**Mémoire et tâches.** Chaque fil Codex reçoit une clé propre, transmise au serveur de mémoire que Codex lance pour ce fil. Pendant un tour, et seulement pendant ce tour, Clark lie cette clé à la tâche en cours. Le serveur de mémoire retrouve ainsi la tâche qui l'appelle, sans deviner. Si la tâche est introuvable ou n'a pas le droit d'écrire, il refuse d'écrire. Les fils Codex sont repris après un redémarrage, selon les mêmes règles que le moteur Claude. Une tâche commencée avec un moteur n'est jamais reprise par l'autre.

**Comparaison avec le moteur Claude.** Avec Claude, une lecture hors du dossier de Clark te demande ton accord. Avec Codex, ton dossier personnel est fermé par le bac à sable, et seuls les fichiers du système et des applications restent lisibles.

## Tâches durables

Chaque demande est écrite dans `data/clark.db` avant d'être traitée. Chaque appel d'outil y est noté avant et après son exécution. Si Clark est coupé, voici ce qui se passe au redémarrage :

| Situation à la coupure | Au redémarrage |
|---|---|
| Tâche pas encore commencée | Il la lance normalement |
| Seulement des lectures en cours (fichier, web, `recall`) | Il reprend la même conversation, au dernier résultat enregistré, et te prévient |
| Une validation sans réponse | Elle est annulée, puis redemandée pendant la reprise |
| Une **écriture** sans résultat enregistré, avec ou sans bouton (fichier du workspace, `remember`, shell…) | **Aucune relance.** Message avec « Reprendre (vérifier d'abord) » ou « Abandonner » |

Le niveau de validation et l'effet d'un outil sont deux choses séparées. Écrire dans le workspace ou en mémoire passe sans bouton en temps normal, mais reste une écriture : si son résultat manque après une coupure, il faut la vérifier. Un outil inconnu est traité comme une écriture.

Dans l'interface, les tâches à vérifier sont lues dans la base : elles restent affichées avec leurs boutons tant que tu n'as pas tranché. Sur Telegram, l'alerte est renvoyée à chaque démarrage tant que son envoi n'a pas été enregistré. Si Telegram la reçoit juste avant un arrêt de Clark, elle peut donc arriver en double. C'est accepté pour le MVP : les boutons d'une même tâche agissent une seule fois, et le doublon répond « Déjà traité ». `/taches` renvoie à tout moment les tâches en attente avec leurs boutons.

Il n'y a jamais de repli silencieux vers une conversation neuve. La seule exception : la reprise échoue avant que quoi que ce soit ait tourné, et il te le dit. Les messages envoyés pendant la coupure sont traités au démarrage.

## Équipe d'agents

Coche **Confier à l'équipe** sous le champ de message (ou `/equipe ta demande` sur Telegram). Clark devient chef d'équipe : il **compose l'équipe** pour la mission, puis la coordonne.

**Plan d'équipe.** Clark choisit d'abord, en lecture seule, les spécialistes de la mission. Il donne à chacun un livrable et indique de quels autres résultats il dépend.
- Il puise dans son catalogue : Chercheur, Spécialiste Contenu, Rédacteur, Relecteur.
- S'il manque une compétence, il crée un **spécialiste temporaire**, par exemple « Spécialiste Accessibilité » pour une revue de portfolio.
- Les droits ne viennent jamais du plan, c'est le code qui les fixe : seul le Rédacteur écrit, tous les autres (spécialistes temporaires compris) sont en lecture seule.
- Un plan illisible, en boucle ou incohérent n'est pas deviné : Clark le dit et passe à l'équipe habituelle.

**Exécution.** Chaque spécialiste part dès que ses dépendances ont rendu leur livrable. Ils sont au plus **deux en même temps**, et seulement s'ils sont tous deux en lecture seule ; un spécialiste qui écrit part seul. Chacun reçoit les livrables dont il dépend. À la fin, Clark fait la **synthèse** : ce que l'équipe a trouvé, puis ce qui reste à trancher par toi.

**Points d'étape.** Chaque agent, et Clark seul sur une tâche longue, note son avancement en une ligne avec l'outil `report_progress`, par exemple « Contraste trop faible sur Projets ; je passe au clavier et aux images ». La ligne s'affiche en direct sous l'agent, dans l'arbre de l'équipe ou sur la carte de la tâche, au-dessus de sa dernière lecture. Elle disparaît quand l'agent a fini. Noter son avancement n'écrit rien d'autre : c'est permis en lecture seule. Avec Codex, la ligne vient du serveur de mémoire ; Clark la repère dans la base chaque seconde. L'idée vient des points d'étape des worktrees d'Orca.

**Tentatives.** Chaque exécution d'un agent est une tentative, avec son propre identifiant, ses droits et ses étapes dans le journal. Le journal refuse de clore un agent avec le résultat d'une ancienne tentative : un résultat tardif n'est jamais attribué à la mauvaise exécution.

**Reprise.** Après une coupure, les livrables déjà rendus sont gardés, le plan aussi, et les agents coupés en pleine lecture reprennent seuls. Si plusieurs ont été coupés en même temps, tous sont repris. Un agent qui écrivait met l'équipe en « À vérifier », comme avant.

**Équipe habituelle**, pour un écrit à produire puis relire (relances, lettre). Clark la choisit, ou elle prend le relais quand le plan n'est pas valable. Elle enchaîne trois agents :
- le **Chercheur** rassemble les faits avec leur source, sans rien modifier ;
- le **Rédacteur** écrit le livrable à partir de ces faits seulement, dans `workspace/equipe/<n°>/` ;
- le **Relecteur** compare le brouillon à la demande et aux faits, puis rend un verdict (OK ou à corriger) et une liste de points.

Les agents ne se parlent pas entre eux : Clark transmet le travail de l'un au suivant. Si le Relecteur demande des corrections, le Rédacteur refait une version.

**Limite de relecture.** Après 2 relectures refusées, Clark s'arrête. Il te montre alors le brouillon, le verdict et les points encore ouverts.

**Droits imposés par le code, pas par la consigne.** Le Chercheur et le Relecteur sont en lecture seule :
- avec le moteur Claude, la politique refuse toute écriture, toute commande et toute proposition de mémoire, sans rien te demander ;
- avec Codex, leur bac à sable est en lecture seule, et Clark refuse d'office les demandes de commande ou de modification ;
- le serveur de mémoire refuse aussi d'écrire pour eux.

Seul le Rédacteur peut écrire.

Chaque agent est une sous-tâche du journal, avec ses propres étapes et sa propre session ; celle de ta conversation n'est pas touchée. Après une coupure :
- un agent terminé n'est jamais relancé, son résultat est réutilisé ;
- un agent coupé pendant une lecture reprend seul ;
- un agent coupé pendant une écriture met toute l'équipe en « À vérifier ».

**Reprise en deux temps.** Avec **Reprendre**, l'agent repart d'abord en lecture seule, toujours imposée par le moteur. Il doit rendre un constat explicite pour chaque écriture coupée : FAIT, PAS FAIT ou PARTIEL.
- **Toutes les écritures sont tranchées** : elles passent en « vérifiées », et l'agent reprend avec ses droits en tenant compte du constat.
- **Un constat manque, est ambigu, contradictoire ou « indéterminé »** : aucun droit d'écrire n'est rendu. La tâche repasse « À vérifier », avec le constat brut sous les yeux. La tâche reste ouverte entre les deux : une coupure à ce moment-là refait la vérification. La même règle vaut pour une tâche seule, hors équipe.

Dans la colonne « En cours », l'arbre Plan → Chercheur → Rédacteur → Relecteur montre le statut de chaque agent. Une demande d'accord indique l'agent qui la fait (« Le Rédacteur demande ton accord »).

**Moteur par rôle.** Pour un regard croisé, chaque rôle peut tourner sur son propre moteur, par exemple Codex rédige et Claude relit. Le réglage se fait dans `.env` :

```
CLARK_ROLE_ENGINES=redacteur=codex,relecteur=claude
```

- **Rôles possibles** : `plan`, `chercheur`, `contenu`, `redacteur`, `relecteur`, `temporaire` (les spécialistes créés par Clark) et `synthese`. Les rôles absents prennent le moteur principal (`CLARK_ENGINE`).
- **Disponibilité.** Claude n'est disponible qu'avec `ANTHROPIC_API_KEY`, et Codex qu'une fois connecté. Si le moteur demandé manque, le moteur principal prend le relais. L'interface le dit (« Moteurs par rôle : Relecteur → Codex (Claude indisponible) »), le journal de démarrage aussi.
- **Trace.** Chaque agent garde le nom du moteur qui l'a exécuté. Quand l'équipe mélange plusieurs moteurs, l'arbre affiche celui de chaque agent.
- **Reprise.** Un agent coupé repart sur le moteur qui l'a commencé, même si le réglage a changé entre-temps, parce qu'une session Codex ne se reprend pas avec Claude, et inversement. Si ce moteur n'est plus disponible, l'équipe s'arrête et le dit au lieu de changer de moteur en douce.

## Questions et notifications

**Questions.** Un agent (ou Clark seul) peut te poser une question au lieu de deviner, avec l'outil `ask_charles`. L'idée vient de l'orchestration d'Orca, sous licence MIT ; aucun code n'en a été copié.
- Sur le web, la carte propose des boutons et un champ de réponse libre. Dans le chat privé Telegram, touche un bouton ou utilise « Répondre » sur le message qui porte la question. Chaque réponse est liée à sa question, même si plusieurs agents t'en posent en même temps.
- L'agent attend ta réponse jusqu'à 30 minutes. Sans réponse, il continue sans et le signale.
- Poser une question est permis aux agents en lecture seule : ça n'écrit rien.
- Avec Codex, la question passe par la base, ce qui marche depuis le serveur de mémoire qui tourne à part. Les questions d'avant un redémarrage expirent ; l'agent repris redemande.

**Notifications.** En bas de la colonne, **Activer** les notifications du navigateur. Quand l'onglet de Clark est en arrière-plan, tu es prévenu dans quatre cas : une question, une demande d'accord, une tâche à vérifier, une réponse de Clark. Le titre de l'onglet affiche aussi le nombre d'éléments qui t'attendent, par exemple « (2) Clark ».

## Automatisations planifiées

Dans **Réglages**, **Nouvelle automatisation** : un nom, une consigne, une fréquence et une heure, en heure de Paris. Les fréquences possibles : chaque jour, en semaine, chaque semaine tel jour, chaque heure. Coche **Confier à l'équipe** pour qu'elle passe par le Chercheur, le Rédacteur et le Relecteur. L'idée vient des automatisations d'Orca.
- **Une occurrence ne part qu'une fois.** Elle est réservée dans la base avant d'être lancée, même si Clark s'arrête juste après.
- **Clark éteint à l'heure prévue** : l'occurrence est rattrapée au démarrage si le retard reste sous 2 h (30 min pour « chaque heure »). Au-delà, elle attend la prochaine.
- **Créer ou réactiver une automatisation ne la lance pas d'un coup**, même si son heure vient de passer.
- Chaque carte montre l'horaire, la prochaine occurrence et le dernier lancement avec son résultat, plus trois boutons : **Lancer maintenant**, **Couper** / **Réactiver**, **Supprimer**.
- Dans le fil, un lancement apparaît comme « Automatisation « nom » : … », jamais comme un message de toi.
- Une automatisation d'équipe passe par le contrôle du quota Codex.
- Les validations restent obligatoires : sans réponse de ta part, une demande d'accord est refusée après 10 minutes.

Seul toi crées ou modifies les automatisations, dans l'interface. Clark ne s'en crée pas lui-même. Le brief du matin reste réglé par `CLARK_BRIEF_HOUR`.

Chaque automatisation peut aussi avoir :
- **un type** : un message à Clark, l'équipe, ou **une tâche dev** sur un projet (elle arrive à relire dans « À toi », comme une autre) ;
- **son moteur, son modèle et son effort** (par exemple Codex en effort faible pour un tri de routine) ;
- **une pré-vérification** : une commande lancée juste avant (60 s au plus, dans le dossier du projet pour une tâche dev) ; si elle échoue, l'occurrence est **sautée** et rien n'est consommé. Exemple : `gh pr list --state open | grep -q .` pour ne tourner que s'il y a des PR ouvertes ;
- **son propre fil** : la consigne et le travail restent à part (avec leur propre mémoire de conversation d'une fois sur l'autre), et le résultat t'est annoncé dans ta conversation ; ses demandes d'accord arrivent dans « À toi » sous son nom ;
- **créée en pause**, pour l'essayer avec « Lancer maintenant » avant de l'activer.

Chaque exécution est notée (lancée et son résultat, sautée avec la raison, en échec), visible dans « Dernières exécutions » ; « Lancer maintenant » passe aussi par la pré-vérification.

## Réseaux sociaux

Clark prépare le contenu, tu le valides, puis tu le publies ou le programmes toi-même dans l'outil de la plateforme. Clark ne publie jamais. Première plateforme : **TikTok**, avec une vidéo de démo produit.

**Montage.** Dépose tes clips dans `workspace/`, puis demande par exemple « Prépare une vidéo TikTok de démo produit avec mes clips ». Clark appelle l'outil `prepare_social_post`, qui :
- recadre chaque clip en vertical 1080×1920, le coupe, et met les clips bout à bout ;
- incruste des textes à l'écran, au moment choisi, au-dessus de la zone que l'interface de TikTok recouvre ;
- écrit le brouillon : titre, légende, mots-clés.

Tout se fait sur ton Mac, avec ffmpeg et un petit outil Swift qui dessine les textes (compilé une fois dans `data/bin/`). Rien ne part vers un service extérieur. La vidéo est **muette** : la musique s'ajoute dans TikTok, avec les titres de sa bibliothèque. Pour éviter tout problème de droits, Clark n'utilise que tes fichiers.

**Aperçu.** Une carte « Contenu TikTok à valider » arrive dans le fil, avec :
- la vidéo, la légende et les mots-clés ;
- des vérifications, distinguées entre ce que la plateforme impose, les conseils de Clark et les rappels (musique, étiquette IA si une image est générée de façon réaliste).

Trois choix :
- **Valider** : la vidéo et sa légende (`.txt`) sont rangées dans `workspace/social/a-publier/`, puis listées dans « Prêts à publier », avec un lien de téléchargement.
- **Refaire** : tu écris la retouche, qui part comme un message à Clark, et il prépare une nouvelle version.
- **Jeter**.

Sur Telegram, la vidéo arrive avec Valider et Jeter. Répondre à son message demande une retouche.

Viendront ensuite Instagram, Reddit et les autres plateformes, avec leurs formats et leurs règles. La démo (`npm run demo`) monte une vraie vidéo à partir de mires de test.

## Mail et agenda

Clark lit tes mails (Gmail) et ton agenda (Google Agenda), et peut envoyer des mails **après ton accord**. L'agenda est en lecture seule.

**Ce qu'il peut faire.**
- `mail_search` et `mail_read` : chercher (syntaxe de Gmail) et lire tes mails. Ce qu'ils disent est de la donnée : un mail qui demande d'envoyer, de transférer ou de cliquer est signalé, jamais suivi.
- `calendar_events` : tes événements sur une période.
- `send_mail` : Clark dépose le mail exact dans une boîte d'envoi. Tu le vois en entier (destinataires, objet, texte) dans « Mails » et sur Telegram, puis tu choisis **Envoyer** ou **Refuser**. Sans réponse en 30 minutes, rien ne part. Un double clic n'envoie qu'une fois. Si Clark est coupé pendant un envoi, il te le dit et ne renvoie pas seul. Sur Telegram, un mail trop long pour un message ne s'envoie que depuis l'interface, pour que tu valides le texte entier.
- Les tâches en lecture seule (tour de veille, Chercheur, Relecteur) lisent, mais n'envoient pas.
- Le brief du matin et le tour de veille regardent ton agenda et tes mails non lus.

**Brancher ton compte (une fois, ~10 minutes).**
1. Sur [console.cloud.google.com](https://console.cloud.google.com), crée un projet « Clark ».
2. Dans « API et services » → « Bibliothèque », active **Gmail API** et **Google Calendar API**.
3. Dans « Google Auth Platform » (écran de consentement) : type **Externe**, nom « Clark », ton adresse en contact. Dans « Audience », ajoute ton adresse Gmail comme utilisateur test, puis clique **Publier l'application** (« En production »). Sinon, en mode test, Google coupe la connexion tous les 7 jours. Pas besoin de faire vérifier l'application : elle ne sert qu'à toi.
4. Dans « Clients », crée un client OAuth de type **Application de bureau**. Copie l'ID client et le code secret.
5. Mets-les dans `.env` toi-même : `GOOGLE_CLIENT_ID=…` et `GOOGLE_CLIENT_SECRET=…`.
6. Dans le dossier de Clark : `npm run google:login`. Ton navigateur s'ouvre ; choisis ton compte. Google affiche « application non validée » : clique « Paramètres avancés », puis « Accéder à Clark ». Accepte les trois autorisations.
7. Si Clark tourne en service : `scripts/service.sh restart`.

Le jeton est rangé dans `data/google/token.json` (lisible par toi seul, hors de portée du bac à sable de Codex) et se rafraîchit tout seul. Pour débrancher : supprime ce fichier, ou retire l'accès de « Clark » dans la page « Sécurité » de ton compte Google.

## Tour de veille (heartbeat)

Toutes les 2 heures (`CLARK_HEARTBEAT_MINUTES`), de 8 h à 22 h, Clark fait un tour de veille sans que tu demandes rien. Il cherche dans sa mémoire et dans ses notes ce qui mérite ton attention : une échéance qui approche, une relance en retard, un oubli probable. Il te fait au plus deux propositions avec `propose_initiative`.

Le tour se fait **en lecture seule**, dans une conversation à part : rien n'apparaît dans ton fil à part ses propositions, et il ne reprend jamais ta session. Chaque proposition arrive dans « Propositions de Clark » (et sur Telegram), avec sa raison et sa source. Tu choisis :
- **Accepter** : la consigne part comme un message à Clark, dans ta conversation. Les écritures demandent ton accord comme d'habitude.
- **Refuser** : il ne la refait pas pendant 30 jours, et le tour suivant voit ton refus.

Il ne tourne pas sans moteur connecté, la nuit, pendant une autre tâche, avec un quota à 90 % ou plus, ou s'il a déjà 3 propositions en attente de toi. La raison s'affiche sous le bloc, avec un lien « Faire un tour maintenant ». Un tour coupé par un redémarrage est abandonné, pas repris.

## Idées

La page **Idées** (icône ampoule) rassemble des idées de projets de dev. Elles arrivent de trois façons :
- **Le tour d'idées** : chaque jour à 15 h (`CLARK_IDEAS_HOUR`, réglable dans Réglages › Général, vide pour couper), Clark parcourt quelques sites avec son navigateur (Show HN, GitHub Trending, Reddit, Product Hunt, X…), fait défiler, ouvre ce qui a l'air prometteur, et note au plus 5 idées qui collent à tes projets avec `note_idea`. Il tourne en lecture seule, dans une conversation à part, et ne se connecte jamais à un site : pour qu'il voie ton fil X, connecte-toi toi-même dans son navigateur. La liste des sites se règle sur la page. Il ne tourne pas sans moteur, pendant une autre tâche, avec un quota à 90 % ou plus, ou avec 15 idées encore à trier. À la fin, une seule note dans ton fil : combien d'idées, et leurs titres.
- **Toi** : tape une idée en vrac sur la page (une phrase, un lien), ou `/idee …` sur Telegram. Clark la creuse tout de suite (case à décocher sur la page).
- **Clark** : une idée qu'il a eue en conversation ou pendant une autre tâche.

Pour chaque idée, tu choisis :
- **Creuser** : Clark cherche ce qui existe déjà, regarde si ça colle à tes projets et à ta stack, estime l'effort et propose un premier pas. Son avis (à faire, pour plus tard, à laisser) et son compte rendu s'affichent sur la carte. En lecture seule ; une recherche coupée remet l'idée à trier.
- **Garder** : l'idée passe dans « Gardées » et une note est écrite dans ton coffre Obsidian (`Clark/Idées/`). Le tour de veille voit tes idées gardées et peut proposer un prochain pas.
- **Lancer** : l'idée part comme un message à Clark dans ta conversation : il propose un plan, et lance une tâche de code si le projet existe dans Dev.
- **Écarter** : Clark ne la repropose plus. « Remettre » la fait revenir, « Supprimer » l'efface.

## Mémoire confirmée

Clark ne retient rien seul : il **propose** un souvenir, avec sa source et parfois une date d'expiration. Tu choisis dans **À toi** :
- **Confirmer** : le souvenir est retenu tel quel ;
- **Corriger** : tu réécris le souvenir (et sa date d'expiration), puis tu confirmes. La proposition d'origine reste notée ;
- **Ignorer** : il n'est jamais utilisé.

Il n'utilise que les souvenirs confirmés et pas encore expirés. C'est vrai pour sa recherche (`recall`) comme pour ceux injectés au démarrage de chaque conversation. Chaque souvenir garde sa source ; Clark doit pouvoir dire d'où il tient une information.

Quand il propose de corriger un souvenir existant, l'ancienne version reste en vigueur jusqu'à ta confirmation. Si tu ignores la correction, rien ne change.

Les souvenirs d'avant cette version restent utilisés et visibles, avec « provenance inconnue ».

La procédure pour le tester à la main est dans [recette/RECETTE.md](recette/RECETTE.md).

## Feuille de route

- **MVP** (ici) : interface web locale et Telegram, moteurs Claude et Codex sur abonnement, mémoire confirmée, validations, tâches durables, équipe d'agents (plan composé par Clark, parallélisme, moteur par rôle), questions, points d'étape, automatisations, brief du matin, tour de veille avec propositions, Gmail et Google Agenda (envoi après accord).
- **V1** : Drive (via un serveur MCP ajouté). Recherche vectorielle (sqlite-vec). Interface accessible depuis le téléphone (Tailscale) et installable (PWA). Passage sur VPS et sauvegarde nuit.
- **V2** : améliorations de lui-même proposées en PR, comparaison multi-modèles, consolidation de la mémoire la nuit, computer use.
- **Module Réseaux sociaux** (TikTok fait, voir plus haut ; Instagram, Reddit et les autres à venir). Préparer et adapter les contenus pour TikTok, Instagram, Reddit et d'autres plateformes. Clark produit les brouillons et les médias selon la plateforme, puis affiche un aperçu pour validation. La première version laisse la publication et la programmation dans les outils de chaque plateforme. Premier cas d'usage : une vidéo de démo produit pour TikTok, montée à partir de tes clips, avec sous-titres. Le même parcours s'étendra ensuite à Instagram, Reddit et aux autres plateformes, avec les formats et les règles de chacune.

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

## Tâches longues

Une tâche de code peut durer :
- **150 étapes par tour** (40 pour une conversation). Si l'agent atteint quand même la limite, il **reprend seul** où il en était, jusqu'à 3 fois, avec un point de reprise à chaque tour.
- **Il vérifie lui-même son travail** : dans son bac à sable (sans réseau, écriture dans sa copie seulement), il lance les tests et le build du projet **sans te demander de clic** ; les dépendances du dépôt (`node_modules`, `.venv`…) lui sont lisibles, jamais le reste du dépôt d'origine (ses `.env` restent fermés). Codex fait pareil (il ne demande que pour sortir de son bac à sable) ; un projet ajouté après son démarrage attend qu'il redémarre.
- **Tests avant ta relecture** : quand l'agent dit « fini », Clark lance la commande de test du projet. Rouge : l'agent corrige seul (2 fois au plus). La tâche t'arrive au vert, ou avec les tests rouges affichés ; Accepter ne garde jamais une version aux tests rouges. Une retouche ou des commentaires de ta part redonnent droit aux relances et corrections.

## Pilote automatique

Pour ne pas tout valider : coche **Pilote auto** dans la barre du champ quand tu lances une tâche de code, du code en parallèle ou un binôme (pas une comparaison, où c'est toi qui choisis).
- Une version prête **et** aux tests verts (et, en binôme, approuvée par le relecteur) est acceptée par Clark seul.
- Un groupe dont toutes les sous-tâches sont acceptées est réuni seul ; un conflit crée une tâche de résolution, reprise par le pilote.
- Puis Clark **ouvre la PR** et te prévient : tu n'as qu'une validation, la relire et la fusionner sur GitHub. Clark ne fusionne jamais.
- Il s'arrête et te rend la main, en disant pourquoi, dès que quelque chose demande un humain : tests rouges après ses corrections, désaccord du binôme, relecture qui n'a pas abouti, décision à prendre.

## Binôme Claude + Codex

Pour les longues tâches de code : « + » › **Binôme Claude + Codex**, un projet, la consigne. Il faut les deux moteurs connectés.
1. **Plan** : Claude lit le projet et découpe la tâche ; Codex critique le plan (ce qui manque, les fichiers partagés, les hypothèses fausses) ; Claude le corrige. La critique reste visible dans le groupe.
2. **Code** : les sous-tâches alternent d'auteur (Claude, Codex, Claude…), chacune dans sa copie.
3. **Relecture croisée** : avant toi, l'autre moteur relit chaque version (en lecture seule) et rend un verdict par points (bloquant, important, mineur). L'auteur corrige, ou conteste un point en le disant. Jusqu'à 3 tours ; s'ils ne sont toujours pas d'accord, la sous-tâche t'arrive avec leurs arguments et tu tranches. Une retouche de ta part relance un cycle.
4. Tu acceptes chaque sous-tâche comme d'habitude, puis la réunion et la PR.

Codex n'est **pas** un moteur de secours : Réglages › Moteurs › Moteur de secours est coupé par défaut.

## Clark travaille sur lui-même

Le dépôt de Clark est un projet dev comme les autres (`clark`, tests : `npm test`). Une tâche de code tourne dans une copie (`workspace/dev/…`), jamais dans le dossier qui tourne ; l'accepter fait un commit sur la branche de la tâche, puis **Ouvrir la PR** l'envoie sur `carls-xyz/clark`. Tu relis et fusionnes sur GitHub, puis, pour que Clark l'utilise : `git pull` dans `~/Developer/clark` et redémarrage (Réglages › Moteurs › Redémarrer, ou `scripts/service.sh restart`). Un sous-dossier de Clark ne peut pas devenir un projet.

## Obsidian et recherche par le sens

**Le coffre.** Par défaut `~/Documents/Obsidian Vault` (ou `CLARK_OBSIDIAN_VAULT=…` dans `.env`, `off` pour couper). Chaque souvenir confirmé y devient une note dans `Clark/Mémoire` : propriétés (type, source, dates, importance), texte, liens vers son type (`[[Faits]]`, `[[Leçons]]`…) et vers les souvenirs proches (« Proche de »). `Clark/Clark.md` est l'accueil. Dans les deux sens, toutes les 2 minutes et à chaque changement :
- tu corriges le texte d'une note → Clark reprend ta version ;
- tu la supprimes (ou la ranges dans `Clark/Mémoire/Oubliés`) → Clark l'oublie (archivé, jamais effacé) ;
- tu écris une note dans `Clark/Mémoire` (propriété `type:` facultative) → Clark l'apprend ;
- Clark oublie un souvenir → sa note part dans `Clark/Mémoire/Oubliés`.

Outils : `vault_search` (par mots et par le sens), `vault_read` (une note, ses liens, ce qui la cite), `vault_write` (seulement dans `Clark/`, hors `Clark/Mémoire`). État, « Synchroniser maintenant » et « Écrire le journal du jour » dans Réglages › Connexions (ce dernier bouton n'apparaît qu'avec un coffre, et répond seulement si Claude est connecté).

**Mémoire en trois couches.**
- **Courte** : les conversations du jour, telles quelles.
- **Moyenne** : le **journal du jour**. Chaque soir à 23 h (ou au démarrage pour la veille, si le Mac était éteint), Clark l'écrit ; tu peux aussi l'écrire avant, avec le bouton « Écrire le journal du jour » (Réglages › Connexions), qui remplace celui du jour s'il existe. Un journal écrit avant 23 h est réécrit à 23 h, pour couvrir toute la journée ; si le modèle rend un journal inutilisable, Clark réessaie une fois 30 min après, puis abandonne pour le jour. Il l'écrit à partir des seuls faits du jour : conversations, demandes, décisions prises seul, tâches de code, souvenirs confirmés. Sections « En bref », « Ce qu'on a fait », « Ce que j'ai décidé seul », « En suspens », avec des liens vers les notes de souvenirs (les liens vers des notes qui n'existent pas sont retirés). Il est rangé dans la base et dans `Clark/Journal/Journal AAAA-MM-JJ.md`. Les trois derniers « En bref » sont relus au début de chaque conversation ; les jours plus anciens se retrouvent par le sens (`vault_search`).
  - Le **résumé de la semaine**. Chaque dimanche à 23 h 30 (heure de Paris), après le journal du jour, Clark résume la semaine écoulée (lundi → dimanche, semaine ISO) à partir des seuls journaux du jour de cette semaine, jamais des conversations brutes ; rien s'il y a moins de 2 journaux. Sections « En bref » (3 à 5 phrases), « Ce qui a avancé », « Décisions et changements », « En suspens ». Mêmes règles que le journal : rien d'inventé, liens seulement vers des notes qui existent (journaux de la semaine, notes de souvenirs), les autres sont retirés. Il est rangé dans la base (table `weekly_summary`, une ligne par semaine) et dans `Clark/Journal/Semaine AAAA-Snn.md` (ex. `Semaine 2026-S47`), avec un lien vers chaque journal de la semaine. Au démarrage, s'il manque celui de la semaine précédente (Mac éteint le dimanche soir), il est écrit. Le « En bref » de la dernière semaine est relu au début de chaque conversation, en une ligne « La semaine dernière : … », sous les derniers jours.
- **Longue** : les souvenirs confirmés (relecture de mémoire, toutes les 20 demandes ou après 15 min de calme).

La veille du soir écrit aussi sa note, `Clark/Veille/Veille AAAA-MM-JJ.md`, que le journal du jour relie.

**Notes par sujet.** Clark regroupe ses souvenirs par ce dont ils parlent (« Portfolio », « Boîte mail », « Travail avec Clark »…) : une note par sujet dans `Clark/Sujets`, avec une phrase de description, ses souvenirs et les jours du journal qui en parlent ; chaque note de souvenir porte « Sujet : [[…]] ». Le regroupement est refait quand la mémoire change (6 h au plus entre deux), en gardant les noms existants ; un sujet a au moins deux souvenirs. Une note que tu écris dans ce dossier n'est jamais supprimée (seules celles marquées `clark_sujet` le sont, quand leur sujet disparaît).

**Par le sens.** Souvenirs et notes ont un vecteur (modèle local `paraphrase-multilingual-MiniLM-L12-v2`, ~120 Mo dans `data/models`, téléchargé une fois). `recall` et `vault_search` mêlent mots et sens. Le modèle tourne dans un processus à part, lancé à la demande, arrêté après 2 minutes sans usage (~650 Mo le temps du calcul). `CLARK_EMBEDDINGS=off` coupe tout. Limite connue : un petit modèle ne sait pas tout (« ma banque » ne trouve pas une note qui ne cite que le nom de la banque) ; la recherche par mots reste à côté.
