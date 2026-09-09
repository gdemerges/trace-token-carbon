# TRACE — Token Rate And Carbon Estimator

Ce que vos outils IA consomment vraiment : tokens par modèle, position dans les
limites de débit, et empreinte carbone. Une icône dans la barre d'état, un
raccourci global pour les jauges, un tableau de bord pour le détail.

macOS · Windows · Linux — Rust et Tauri. **4,4 Mo empaqueté**, contre 287 Mo
pour le runtime Electron qu'employait la version précédente.

---

## Démarrer

```bash
cargo run -p trace-app     # lance l'application
cargo run -p trace-cli     # les mêmes chiffres, dans le terminal
cargo test                 # 135 tests sur le cœur, la présentation et les catalogues
cargo tauri build          # empaquette pour le système courant
```

Rust 1.82 ou plus récent. Sous Linux, la webview du système demande
`libwebkit2gtk-4.1-dev`, `libappindicator3-dev` et `librsvg2-dev`.

Les tests tournent en intégration continue sur les trois systèmes
(`.github/workflows/rust.yml`), avec `clippy` et `rustfmt` en erreur bloquante.
Ce n'est pas une précaution de principe : les chemins de fichiers, les
permissions POSIX, la construction du dossier de configuration et surtout la
détection de processus vivant diffèrent d'un système à l'autre, et la CI a
attrapé sur Windows deux fautes qu'aucune machine macOS ne pouvait montrer.

### Architecture

Trois membres, et la frontière entre eux est ce qui fait tenir le reste :

```
crates/trace-core/   lecture des journaux, tarification, carbone, agrégation,
                     limites de débit, alertes. Ne connaît NI Tauri NI aucune
                     interface : c'est ce qui permet de l'éprouver sur les
                     trois systèmes sans rien lancer.
crates/trace-cli/    le binaire `trace`.
src-tauri/           barre d'état, popover, tableau de bord.
src/renderer/        l'interface, en JavaScript sans bundler ni framework.
```

Le renderer n'a pas été réécrit lors du passage d'Electron à Tauri : le même
DOM, le même SVG écrit à la main, la même feuille de style. Seul le pont IPC
change, et il expose exactement la même surface.

## Utiliser

| Geste | Effet |
|---|---|
| `⌘⌥T` (`Ctrl+Alt+T`) | Ouvre les jauges par-dessus n'importe quelle application |
| Clic sur l'icône | Idem |
| `Échap` | Referme le popover |
| `⌘Tab` | Atteint le tableau de bord quand il est ouvert |
| `⌘↩` | Ouvre le tableau de bord |
| `trace --json` | Sortie machine, pour une barre de statut ou un script |
| `trace --carbone` | Eau, sensibilité au mix électrique, décomposition de l'incertitude |
| `trace --lang=en` | Force la langue (`fr`, `en`) |

Le raccourci, la langue, le mix électrique, l'intervalle de rafraîchissement, la
métrique affichée dans la barre d'état, la profondeur de détail conservée et la
vérification de version se règlent depuis l'engrenage du tableau de bord.

### Langue

Français et anglais. Par défaut TRACE suit la langue du système ; le réglage la
force. Le changement s'applique sans redémarrage — y compris aux libellés
calculés par le cœur (fenêtres, sources, équivalents carbone) et au format des
nombres et des dates.

Les catalogues sont deux fichiers JSON (`src/i18n/`), embarqués dans le binaire
et transmis à l'interface par IPC : le renderer n'a aucun accès au système de
fichiers, et c'est délibéré. Un test vérifie que les deux langues
portent exactement les mêmes clés, avec les mêmes paramètres, et que toute clé
employée dans le code existe — une clé mal orthographiée s'afficherait telle
quelle à l'écran sans que rien d'autre ne le signale.

**Ce qui reste en français :** les notes et citations de l'annexe
méthodologique carbone (`carbon/factors.rs`, `carbon/sources.rs`). Ce sont des
textes destinés à un livrable auditable, encore en cours de figeage ; les
traduire vite en ferait deux versions à maintenir dont une non relue.

---

## Ce que chaque source fournit réellement

TRACE agrège cinq sources. Elles ne sont pas équivalentes, et l'application le
dit au lieu de le masquer :

| Source | Tokens | Limites de débit | Comment |
|---|:--:|:--:|---|
| **Claude Code** | ✅ | ~ | Journaux locaux `~/.claude/projects`. Ventilation du cache par TTL, donc tarification exacte. |
| **Claude — usage en direct** | — | ✅ | Interroge `/api/oauth/usage`, l'endpoint que Claude Code utilise pour sa commande `/usage`, avec les identifiants OAuth déjà présents sur la machine. **Seule source juste** pour l'occupation des fenêtres. |
| **Codex CLI / Desktop** | ✅ | ✅ | Rollouts `~/.codex/sessions`. Le serveur y écrit déjà un pourcentage d'utilisation par fenêtre. |
| **API Anthropic** | ✅ | — | Rapports d'usage et de coût de l'organisation. Chiffres **facturés**, toutes machines confondues. Clé Admin requise. |
| **API OpenAI** | ✅ | — | Rapport d'usage de l'organisation. Clé Admin requise. |

**Gemini, Grok et Ollama ont été retirés.** Ils avaient été ajoutés puis
inspectés en profondeur : aucun des trois n'écrit de compteur de tokens
exploitable en local. Gemini CLI le permettait via sa télémétrie
OpenTelemetry, mais ce client n'est plus supporté, et Antigravity qui le
remplace ne persiste ni compteurs ni quota — son gestionnaire de quota
recharge depuis le serveur sans rien écrire. Grok CLI ne journalise que des
diagnostics d'authentification. Ollama ne conserve pas les compteurs que son
API renvoie pourtant à chaque appel.

Plutôt que de conserver trois sources incapables de produire un chiffre, elles
ont été supprimées. Le principe reste : jamais d'extrapolation depuis le
nombre de caractères, qui produirait une valeur fausse présentée comme une
mesure.

---

## Méthodologie

### Empreinte carbone

Méthode **EcoLogits / Boavizta**, appliquée telle quelle :

1. L'énergie GPU par token généré est linéaire en nombre de paramètres
   **actifs** — ce qui vaut aussi bien pour un modèle dense que pour un
   mixture-of-experts.
2. Le reste du serveur est imputé au prorata des GPU mobilisés, via la latence.
3. Le PUE du centre de données couvre refroidissement et pertes de distribution.
   TRACE ne prend pas le PUE générique de 1,2 : chaque fournisseur porte la
   fourchette annoncée par les exploitants qui l'hébergent (Anthropic sur AWS
   et Google Cloud, OpenAI sur Azure), et un fournisseur inconnu s'ouvre
   jusqu'au centre de données de colocation ordinaire.
4. La fabrication du matériel est amortie sur cinq ans, au prorata du temps
   d'occupation.
5. L'**empreinte eau** suit la même énergie : le refroidissement sur site (WUE
   du fournisseur, rapporté à l'énergie informatique) plus l'eau consommée hors
   site pour produire l'électricité, qui domine généralement la première.

**Extension propre à TRACE, assumée comme telle.** EcoLogits ne compte que les
tokens de *sortie*. Pour un usage agentique c'est intenable : on observe ici
1,30 Md de tokens lus en cache pour 4,4 M générés. Les ignorer sous-estimerait
l'empreinte de deux ordres de grandeur. Chaque classe de token est donc
pondérée par son coût énergétique relatif à un token décodé, calé sur un bilan
de FLOPs plutôt qu'à l'intuition — un prefill de 37 k tokens sur un modèle à
100 Md de paramètres actifs représente 7,4·10¹⁵ FLOPs, soit ~6,6 Wh sur huit
A100 à 40 % de MFU, d'où un rapport d'environ 0,017 par rapport au décodage.

**Le résultat est une fourchette, jamais un point.** Les fournisseurs ne
publient pas la taille de leurs modèles : les paramètres sont des estimations à
bornes larges, qui se propagent jusqu'à l'affichage. Un chiffre unique
laisserait croire à une mesure.

À noter : EcoLogits produit des valeurs supérieures aux auto-déclarations des
fournisseurs (≈ 2 Wh contre ≈ 0,3 Wh pour une requête courte). C'est une
divergence méthodologique connue, pas une erreur de calcul.

Le mix électrique est réglable (France 56 g/kWh … monde 480 g/kWh). Par défaut
la moyenne états-unienne pour les modèles fermés, puisque l'essentiel de la
capacité d'inférence s'y trouve ; le mix local pour un modèle exécuté chez vous.

### Analyse de sensibilité

Un total unique n'est pas défendable : il repose sur une hypothèse de
localisation et sur des tailles de modèles non publiées. Le total est donc
livré avec de quoi le contester, à l'écran comme en ligne de commande
(`trace --carbone`) et dans la sortie `--json` :

- **le même total sous quatre mix électriques** (France, UE, États-Unis,
  monde), avec le rapport au mix retenu ;
- **la décomposition de l'incertitude**, levier par levier. Chaque levier est
  rejoué seul, les autres figés sur leur milieu, et le rapport borne haute /
  borne basse obtenu mesure ce qu'il apporte à lui seul. En pratique la taille
  des modèles et le mix électrique dominent (× 5 chacun), la pondération des
  tokens suit (× 2,4), et le PUE ne pèse presque rien (× 1,1) — c'est la seule
  hypothèse pour laquelle les exploitants publient quelque chose.

Ce n'est pas une propagation d'incertitude au sens statistique : les bornes ne
sont pas des intervalles de confiance et les leviers ne se composent pas
linéairement. C'est une analyse de sensibilité, et l'interface le dit.

### Traçabilité des facteurs

Chaque constante du calcul est rattachée à une source dans
`crates/trace-core/src/carbon/sources.rs`, et `factor_table()` produit le tableau
annexable à un rapport : valeur, unité, citation, réserve d'usage.

Un champ `pinned` distingue les sources dont la version exacte et la date de
consultation ont été relevées **sur la publication** de celles qui ne le sont
pas encore. Une source non figée reste utilisable dans l'application — l'ordre
de grandeur est bon — mais pas dans un livrable audité, et sa citation le dit
en toutes lettres plutôt que de faire semblant. Inventer un numéro de version
pour faire propre serait pire qu'une citation absente : ça passerait la
relecture.

Deux tests tiennent la discipline : l'un refuse toute constante sans source,
l'autre fige la liste de ce qui reste à relever, pour qu'en figer une soit un
geste délibéré et qu'en ajouter une non figée ne passe pas inaperçu.

Le tableau ne reste pas dans le code : la carte **Méthodologie et sources** du
tableau de bord l'affiche en entier, précédée du décompte des sources non
figées, et « Exporter » écrit un second fichier `…-methodologie.csv` à côté des
données. Un tableau de grammes sans les facteurs qui l'ont produit n'est pas
vérifiable.

Les mix électriques sont tous des facteurs de **localisation** (location-based
au sens du GHG Protocol). Ils ignorent les garanties d'origine achetées par les
exploitants de centres de données, qui feraient s'effondrer le chiffre en
approche market-based. C'est le choix conservateur, et le seul calculable sans
publication des fournisseurs.

### Limites de débit

Les plafonds des plans Claude ne sont publiés nulle part, varient selon le plan
et le modèle, et **le taux d'occupation réel n'est stocké nulle part en local** :
`/usage` l'obtient en interrogeant l'API. Par ordre de fiabilité décroissante :

1. **Le relevé en direct.** TRACE interroge le même endpoint que la commande
   `/usage` de Claude Code, avec les identifiants OAuth déjà déposés sur la
   machine. Le jeton ne quitte jamais le module qui le lit : ni journal, ni
   configuration, ni interface. C'est le chiffre d'Anthropic, il prime sur
   tout le reste.

   **Discipline d'interrogation**, apprise à la dure — la première version
   appelait l'endpoint à chaque cycle, soit toutes les vingt secondes, et s'est
   fait renvoyer un `429` avec une jauge figée sur la dernière valeur connue :

   - un appel toutes les **5 minutes** au maximum, découplé du rafraîchissement
     local qui, lui, ne relit que des fichiers ;
   - **report exponentiel** sur échec (2, 4, 8… minutes, plafonné à une heure),
     et respect de l'en-tête `Retry-After` quand le serveur le fournit ;
   - le dernier relevé est **persisté**, un seul par fenêtre, remplacé à chaque
     succès. Il survit donc à un redémarrage, et un redémarrage ne déclenche pas
     d'appel si le relevé en cache est récent ;
   - passé 20 minutes, la valeur reste affichée — c'est la meilleure information
     disponible — mais l'interface annonce son âge au lieu de la présenter comme
     courante. **Un chiffre daté vaut mieux qu'une estimation fausse** ;
   - **la cadence s'annonce** : la jauge indique l'âge du relevé *et* l'échéance
     du suivant (« en direct · il y a 4 min · prochain relevé dans 11 min »).
     Dire l'âge seul ne suffisait pas — un chiffre immobile pendant un quart
     d'heure se lit comme une panne, et on prend l'habitude de cliquer sur ⟳ à
     chaque consultation. Attendre la cadence n'est pas un incident, et n'est
     donc pas signalé comme tel : le bandeau rouge reste réservé aux vrais
     échecs ;
   - le bouton ⟳ court-circuite la cadence.
2. **Votre relevé manuel.** Si le direct n'est pas disponible : tapez `/usage`,
   cliquez sur « ajuster » sous la jauge et reportez le chiffre. TRACE remonte
   au plafond par produit en croix.
3. **Auto-calibrage sur un refus de fenêtre passé.** Ordre de grandeur
   seulement : mesuré sur un cas réel, l'écart atteignait un facteur 2,6. La
   valeur s'affiche avec un « ≈ » et une jauge à segments évidés, pour qu'on ne
   la confonde jamais avec une mesure.
4. **Rien de tout cela** : la consommation de la fenêtre est affichée sans
   pourcentage. Une jauge sans échelle vaut mieux qu'une jauge fausse.

Pour Codex, un relevé dont la fenêtre a expiré n'est pas réaffiché tel quel :
la fenêtre s'est réinitialisée depuis. TRACE s'en sert comme point de calibrage
et recalcule l'occupation de la fenêtre courante — donc 0 % si vous n'avez pas
touché à Codex depuis.

Un piège important est traité ici : `rateLimitType` vaut toujours `five_hour`,
y compris quand la requête a en réalité été bloquée par un **plafond de dépense
mensuel**. Sur ce poste, deux refus sur trois étaient de ce type. Les confondre
calibrerait la jauge 5 h sur un événement sans rapport avec elle — TRACE classe
donc la cause réelle à partir du message et n'utilise que les vrais refus de
fenêtre.

L'origine de l'échelle est toujours écrite sous la jauge.

La consommation est **pondérée** (sortie ×5, écriture de cache ×1,25, lecture
×0,1) : un total brut serait écrasé par le cache et ne suivrait pas du tout le
comportement réel des plafonds.

### Ne jamais compter deux fois

Trois pièges distincts, trois parades. Ils ont en commun de produire des
chiffres **trop grands**, ce qui est la pire des erreurs pour un outil dont on
attend qu'il dise quand lever le pied.

**1. Le doublon de streaming.** Claude Code réécrit chaque message au fil du
streaming : sur ce poste, **4 345 des 10 577 entrées sont des doublons**. Sans
déduplication par `message.id`, la facture affichée serait gonflée de ~70 %.
Codex, lui, expose à la fois un cumul de session et un delta par tour — sommer
le cumul multiplierait la consommation par le nombre de tours.

**2. L'empilement des agrégats journaliers.** Les rapports d'organisation
(APIs Admin Anthropic et OpenAI) renvoient un agrégat de la journée **en
cours**, qui grossit d'un relevé à l'autre. Fusionnés comme un flux
d'événements, les états successifs s'additionnaient au lieu de se corriger : à
une minute de cadence, la journée courante finissait comptée plus de mille
fois. Ces sources sont désormais fusionnées par **remplacement** sur la clé
`(jour, source, modèle, projet)` — un relevé vide, causé par une coupure
réseau, n'efface rien.

**3. La mesure locale et la facture.** `claude-code` lit les journaux de cette
machine, `anthropic-api` lit la facturation de l'organisation : ce sont les
**mêmes requêtes vues deux fois**. Les additionner doublait le total dès
qu'une clé Admin était renseignée, jauges comprises. La règle appliquée
(`crates/trace-core/src/provenance.rs`) :

- la mesure locale garde la main sur les jours qu'elle couvre — elle seule
  porte le projet, la session et l'heure ;
- le chiffre facturé ne comble que les jours où cette machine n'a rien vu
  passer : une autre machine, un autre poste, une période antérieure à
  l'installation ;
- l'écart entre les deux n'est pas masqué pour autant : il devient la carte
  **« Mesuré ici / facturé »**, seule vérification *externe* dont TRACE dispose
  sur ses propres chiffres. Un écart durable dit soit qu'une autre machine
  consomme sur le même compte, soit que la lecture des journaux se trompe. Les
  deux méritent d'être vus plutôt que moyennés en silence.

Un agrégat journalier ne nourrit par ailleurs **aucune jauge** : horodaté à
minuit, il déversait la consommation d'une journée entière — toutes machines
confondues — dans la fenêtre de cinq heures qui contient minuit.

---

## Présence dans le Dock (macOS)

TRACE est une application d'arrière-plan : **aucune icône dans le Dock au
repos**, c'est le propre d'un outil de barre de menus.

L'icône apparaît en revanche tant que le tableau de bord est ouvert, et
disparaît à sa fermeture. Sans cela la fenêtre devenait un piège : introuvable
au `⌘Tab`, et définitivement perdue si elle passait derrière une autre. Un clic
sur l'icône du Dock rouvre le tableau de bord, comme dans n'importe quelle
application macOS.

Effet de bord bienvenu : tant que l'icône est présente, le menu applicatif
l'est aussi, et les raccourcis d'édition standard fonctionnent dans les champs
de saisie des réglages.

## Alertes

TRACE prévient par une notification système au franchissement d'un seuil
(80 % et 95 % par défaut, modifiables). Trois règles gouvernent ce
comportement :

- **Jamais sur une échelle approximative.** Seules les jauges dont l'échelle
  vient du serveur ou de votre calage déclenchent une alerte. L'estimation
  déduite d'un refus 429 s'était révélée fausse d'un facteur 2,6 — une alerte
  fausse détruirait la confiance dans toutes les autres.
- **Une fois par seuil et par fenêtre.** Le franchissement est un événement,
  pas un état : répéter la notification à chaque cycle ferait de l'outil une
  nuisance. Un bond de 0 à 96 % ne produit qu'une notification, celle du seuil
  le plus haut franchi.
- **Une nouvelle fenêtre réarme les seuils.** Une fenêtre glissante, qui n'a
  pas de réinitialisation annoncée, se réarme une fois par heure : une
  saturation qui dure mérite plus d'un rappel, mais pas un par minute.

### Trajectoire

Le seuil dit où vous en êtes ; la trajectoire dit où vous allez. À 40 % en
montant vite il reste le temps d'agir, à 80 % souvent plus : c'est la pente,
pas le niveau, qui indique s'il faut lever le pied.

Chaque jauge porte donc une projection — *« pleine dans 26 min à ce rythme »* —
calculée sur la cadence des **45 dernières minutes**, et visible dans le
tableau de bord, le popover, l'infobulle de la barre d'état et la CLI. Trois
refus délibérés la rendent défendable :

- **Sans échelle fiable, pas de projection.** Il faut un plafond mesuré, ou
  déduit d'un pourcentage communiqué par le serveur.
- **Sans activité récente, pas de projection.** Une cadence nulle ne sature
  jamais ; annoncer « dans 340 h » serait du bruit.
- **Une saturation postérieure à la réinitialisation n'en est pas une.**
  Atteindre le plafond à 3 h du matin n'a aucune importance si la fenêtre se
  vide à 2 h.

Une alerte de trajectoire est émise **une seule fois par fenêtre**, et
seulement **avant le premier seuil** : plus tard, elle doublerait l'alerte de
seuil au lieu de l'anticiper.

## Confidentialité

Tout est local. Les journaux analysés contiennent votre code et vos
conversations : TRACE ne les envoie nulle part.

Les requêtes réseau, exhaustivement :

| Destination | Quand | Ce qui part |
|---|---|---|
| `api.anthropic.com/api/oauth/usage` | toutes les 15 min, si Claude Code est connecté | le jeton OAuth déjà présent sur la machine |
| `api.anthropic.com` (rapports d'organisation) | à chaque cycle, **si** une clé Admin est renseignée | la clé Admin |
| `api.openai.com` (rapport d'organisation) | idem | la clé Admin |
| `api.github.com` | au démarrage puis une fois par jour, si `checkUpdates` est actif | rien d'autre que l'adresse IP et la version installée |

Le dernier est le seul ajouté sans qu'on le demande, et il se coupe d'un clic
dans les réglages : rien n'est téléchargé ni installé, c'est une notification
et un lien.

- Le renderer n'a **aucun accès** au système de fichiers (`contextIsolation`
  actif, `nodeIntegration` désactivé, surface IPC énumérée explicitement) et
  tourne sous une **politique de sécurité du contenu** qui interdit tout par
  défaut : script local uniquement, aucune connexion sortante, aucune ressource
  distante. Les noms de projets et de modèles viennent de journaux analysés —
  ils sont échappés à l'affichage, et la CSP est la seconde barrière.
- Les clés d'API sont chiffrées par le trousseau du système (`safeStorage`).
  Si le trousseau est indisponible, TRACE **refuse** d'enregistrer la clé
  plutôt que de l'écrire en clair.
- Index et préférences vivent dans le répertoire de configuration standard de
  la plateforme. Le dossier est en `0700`, `config.json` et `index.json` en
  `0600` : l'index porte le nom de tous vos projets, vos identifiants de
  session et votre volumétrie. Sur macOS le dossier héritait déjà du `0700`
  d'Electron, ce qui masquait le problème ; sous Linux (`~/.config/trace`) le
  mode par défaut donnait `0755`, et l'index `0644`.

---

## Architecture

```
crates/trace-core/src/
  collectors/    une source = un module, isolé (une source en échec n'en bloque aucune autre)
  carbon/        estimateur EcoLogits, facteurs, registre des sources citables
  models.rs      registre : tarifs, fenêtres de contexte, paramètres estimés
  ratelimits.rs  reconstruction des fenêtres, calibrage, projection de saturation
  aggregate.rs   coût et carbone calculés PAR MODÈLE puis sommés, jamais sur un tarif moyen
  provenance.rs  qui mesure quoi, et qui l'emporte quand deux sources se superposent
  present.rs     ce que la barre d'état affiche — logique pure, donc testable
crates/trace-cli/  le binaire `trace`
src-tauri/src/     barre d'état, popover, tableau de bord, icônes PNG générées
src/renderer/      popover et tableau de bord — HTML/CSS/JS natifs, SVG écrit à la main
src/i18n/          deux catalogues JSON, embarqués dans le binaire
```

L'indexation est incrémentale : chaque fichier est relu depuis un offset en
octets, et les lignes incomplètes — Claude Code écrit pendant qu'on lit — sont
reprises au passage suivant. Sur 186 Mo de journaux : **230 ms à froid**, et rien
ensuite tant qu'aucun fichier n'a grossi.

### Un seul processus écrit l'index

L'application et la CLI partagent le même fichier, et toutes deux le relisent,
le complètent, puis le réécrivent en entier. Lancer `trace` pendant que
l'application tourne faisait donc s'écraser mutuellement les offsets des
collecteurs.

Un verrou par fichier n'y suffirait pas : la fenêtre à protéger n'est pas
l'écriture — atomique, quelques millisecondes — mais tout le cycle
lecture → collecte → écriture. L'application se déclare donc **propriétaire**
de l'index à chaque cycle ; les autres processus lisent et affichent des
chiffres justes, mais n'écrivent pas. La marque expire au bout de cinq minutes,
et un arrêt brutal ne condamne pas le fichier.

### Compaction

L'index conservait un enregistrement par requête sur toute la rétention — trois
ans. Or au-delà de quelques semaines, plus aucune vue ne consomme la requête
unitaire : série journalière, histogramme horaire, ventilations par modèle et
par projet passent toutes par une agrégation.

Au-delà de **90 jours** (réglable, 0 désactive), les requêtes sont donc repliées
en agrégats **horaires**. Mesuré sur un index réel, replier à l'heure divise le
volume par 46, replier au jour par 98 — le facteur deux gagné coûterait
l'histogramme horaire, la vue qui montre les rythmes de travail. Ce qui est
perdu, et assumé : la session, qu'un agrégat horaire recouvre plusieurs fois.
Le classement des sessions ne remonte donc pas au-delà de la frontière de
compaction, ce qui est de toute façon le seul horizon où il veut dire quelque
chose.

Une relecture complète des journaux — provoquée par un élargissement de la
rétention — ne ressuscite pas le détail replié : la borne de compaction voyage
avec l'index et écarte à l'entrée tout ce qui est plus ancien.

## Jusqu'où remonte l'historique

Périodes disponibles : 24 h, 7 j, 30 j, 90 j, 1 an, et **Tout** — qui remonte
aussi loin que les sources le permettent. La date du plus ancien événement
indexé est affichée à côté du sélecteur : une période longue qui paraît vide
s'explique alors par la source, et non par une perte de données.

Car la limite ne vient pas de TRACE, qui garde trois ans, mais des outils :

- **Claude Code** purge ses sessions au bout de ~2 mois. Rien avant n'est
  récupérable — `stats-cache.json` conserve une activité plus ancienne, mais
  sans aucun compteur de tokens.
- **Codex** garde ses rollouts bien plus longtemps ; ses plus anciens fichiers
  (format `.json`, avant 2026) ne contiennent en revanche aucun compteur.

Élargir la rétention dans la configuration déclenche automatiquement une
relecture complète des sources : l'historique déjà élagué ne reviendrait pas
tout seul, les collecteurs reprenant leur lecture à un offset.

## Recoupement : pourquoi les chiffres diffèrent de `stats-cache.json`

Claude Code tient son propre compteur dans `~/.claude/stats-cache.json`. Il
annonce **1,69× le total de TRACE**, de façon constante jour après jour.

Ce n'est pas TRACE qui sous-compte : ce cache additionne les réécritures de
streaming. Vérification directe sur les mêmes journaux — 2,33 Md de tokens
sans déduplication, 1,38 Md avec, soit un rapport de 1,69× qui correspond
exactement à l'écart observé. Un même message écrit trois fois pendant sa
génération n'est facturé qu'une fois.

## Logos de fournisseurs

Déposez un fichier dans `logo/` (PNG ou WebP, fond transparent) puis lancez
`npm run logos` : il est reconnu par son nom de fichier, redimensionné et
intégré en base64 dans `src/renderer/shared/logos.js`. Les scripts d'empaquetage
le font automatiquement.

Les logos sont rendus en **masque CSS**, pas en image. Ce sont des silhouettes
monochromes, et le masque laisse la couleur suivre le thème : le logo OpenAI
est noir dans son fichier, ce qui serait invisible sur fond sombre — en masque
il devient blanc, ce qui est précisément son usage officiel. Le logo Claude
garde son terracotta de marque, lisible sur les deux fonds.

Un fournisseur sans fichier retombe sur un glyphe géométrique dessiné dans
`marks.js` — une forme neutre vaut mieux qu'une marque déposée reproduite de
travers.

## Un mot sur les couleurs

L'interface tient à un codage strict : **ambre = tokens, sarcelle = CO₂e, bleu =
coût**. Une couleur porte donc toujours la même information, et un graphe se lit
sans sa légende.

Les marques de fournisseur (à gauche des noms de modèles et des jauges) sont
donc identifiées par leur **forme**, et teintées hors de ce trio — sans quoi un
logo sarcelle sur la même ligne qu'une valeur CO₂e sarcelle deviendrait ambigu.

## Distribution

`build/entitlements.mac.plist` porte le jeu d'habilitations macOS, et pas une
de plus — chaque habilitation ajoutée élargit ce que l'application peut faire
une fois compromise.

Sans **notarisation**, le DMG est refusé par Gatekeeper sur toute machine autre
que celle qui l'a construit. Le workflow l'active ; elle ne se déclenche que si
la signature a eu lieu, la construction locale sans certificat reste donc
possible. Les secrets attendus par `.github/workflows/release-tauri.yml`,
déclenché sur un tag `v*` :

| Secret | Rôle |
|---|---|
| `MAC_CERTIFICATE_P12` / `MAC_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` | certificat « Developer ID Application » |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarisation |
| `WIN_CERTIFICATE_P12` / `WIN_CERTIFICATE_PASSWORD` | signature Authenticode |

Absents, le workflow produit des binaires non signés et le dit, plutôt que
d'échouer sur un certificat qu'un fork n'a pas.

**Pas de mise à jour automatique**, et il n'y en aura pas : installer du code
en arrière-plan sur la machine de quelqu'un demande une chaîne de confiance
qu'une application de barre de menus sans serveur ne peut pas tenir
sérieusement. TRACE se contente de lire la dernière version publiée et de le
dire une fois (`crates/trace-core/src/update.rs`).

---

## Limites connues

- Les paramètres des modèles fermés sont estimés : la fourchette carbone couvre
  environ un ordre de grandeur. C'est irréductible sans publication des
  fournisseurs.
- Les tarifs sont figés dans `crates/trace-core/src/models.rs` et doivent être mis à jour
  quand ils changent (surchargeables via `modelOverrides` dans la configuration).
- La pondération des limites de débit est une approximation : les vrais
  plafonds pondèrent aussi par modèle, selon une formule non publiée. D'où le
  calibrage manuel, qui court-circuite le problème en partant d'une valeur vraie.
- Gemini CLI et Ollama ne fournissent pas d'historique de tokens (voir plus haut).
- Le départage mesure locale / facturation raisonne à la **journée** : si vous
  utilisez le même compte depuis cette machine *et* depuis une autre le même
  jour, la part de l'autre machine n'est pas comptée dans les totaux. La carte
  « Mesuré ici / facturé » la rend visible, mais ne la réintègre pas — il
  faudrait pour cela un horodatage par requête que les rapports d'organisation
  ne donnent pas.
- **Copilot Chat** stocke ses sessions dans une base SQLite
  (`globalStorage/github.copilot-chat/session-store.db`). Elle n'a pas été
  inspectée : tant qu'on n'a pas vérifié qu'elle contient de vrais compteurs de
  tokens, aucun collecteur ne sera écrit. C'est la même règle qui a fait
  retirer Gemini, Grok et Ollama — jamais de source incapable de produire un
  chiffre mesuré.

## Licence

MIT
