# TRACE — Token Rate And Carbon Estimator

Ce que vos outils IA consomment vraiment : tokens par modèle, position dans les
limites de débit, et empreinte carbone. Une icône dans la barre d'état, un
raccourci global pour les jauges, un tableau de bord pour le détail.

macOS · Windows · Linux — Electron, **zéro dépendance à l'exécution**.

---

## Démarrer

```bash
npm install
npm start          # lance l'application
npm run dev        # ouvre le tableau de bord directement (développement)
npm test           # 25 tests sur le cœur métier
npm run cli        # les mêmes chiffres, dans le terminal
```

Empaqueter : `npm run dist:mac` · `dist:win` · `dist:linux`.

## Utiliser

| Geste | Effet |
|---|---|
| `⌘⌥T` (`Ctrl+Alt+T`) | Ouvre les jauges par-dessus n'importe quelle application |
| Clic sur l'icône | Idem |
| `Échap` | Referme le popover |
| `⌘Tab` | Atteint le tableau de bord quand il est ouvert |
| `⌘↩` | Ouvre le tableau de bord |
| `trace --json` | Sortie machine, pour une barre de statut ou un script |

Le raccourci, le mix électrique, l'intervalle de rafraîchissement et la métrique
affichée dans la barre d'état se règlent depuis l'engrenage du tableau de bord.

---

## Ce que chaque source fournit réellement

TRACE agrège six sources. Elles ne sont pas équivalentes, et l'application le
dit au lieu de le masquer :

| Source | Tokens | Limites de débit | Comment |
|---|:--:|:--:|---|
| **Claude Code** | ✅ | ~ | Journaux locaux `~/.claude/projects`. Ventilation du cache par TTL, donc tarification exacte. |
| **Claude — usage en direct** | — | ✅ | Interroge `/api/oauth/usage`, l'endpoint que Claude Code utilise pour sa commande `/usage`, avec les identifiants OAuth déjà présents sur la machine. **Seule source juste** pour l'occupation des fenêtres. |
| **Codex CLI / Desktop** | ✅ | ✅ | Rollouts `~/.codex/sessions`. Le serveur y écrit déjà un pourcentage d'utilisation par fenêtre. |
| **API Anthropic** | ✅ | — | Rapports d'usage et de coût de l'organisation. Chiffres **facturés**, toutes machines confondues. Clé Admin requise. |
| **API OpenAI** | ✅ | — | Rapport d'usage de l'organisation. Clé Admin requise. |
| **Gemini CLI** | ❌ | ❌ | Ne journalise que les prompts en local, aucun compteur de tokens. Seule l'activité est remontée. |
| **Grok CLI** | ❌ | ❌ | `unified.jsonl` ne contient que des diagnostics d'authentification, et `session_search.sqlite` n'est qu'un index plein-texte. Le binaire n'expose aucun endpoint d'usage. Seule l'activité est remontée. |
| **Ollama** | ❌ | — | Renvoie `eval_count` dans chaque réponse mais n'en garde aucune trace. Seul l'état courant (modèles chargés) est lisible. |

Les modèles Grok sont malgré tout déclarés dans le registre, avec un tarif
`null` — « coût inconnu », ce qui reste visible dans l'interface, et non
« gratuit », ce qui serait un mensonge. Renseignez-les via `modelOverrides` si
vous les connaissez : le jour où une source fournit des tokens (API xAI, ou
version ultérieure du CLI), ils seront correctement chiffrés.

Les lignes sans token sont des limites des outils eux-mêmes, pas de TRACE.
Plutôt que d'extrapoler un nombre de tokens à partir du nombre de caractères —
ce qui produirait un chiffre faux présenté comme une mesure — ces collecteurs
déclarent `providesTokens: false` et l'interface les affiche comme tels.

---

## Méthodologie

### Empreinte carbone

Méthode **EcoLogits / Boavizta**, appliquée telle quelle :

1. L'énergie GPU par token généré est linéaire en nombre de paramètres
   **actifs** — ce qui vaut aussi bien pour un modèle dense que pour un
   mixture-of-experts.
2. Le reste du serveur est imputé au prorata des GPU mobilisés, via la latence.
3. Le PUE du centre de données couvre refroidissement et pertes de distribution.
4. La fabrication du matériel est amortie sur cinq ans, au prorata du temps
   d'occupation.

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

### Déduplication

Claude Code réécrit chaque message au fil du streaming : sur ce poste, **4 345
des 10 577 entrées sont des doublons**. Sans déduplication par `message.id`, la
facture affichée serait gonflée de ~70 %. Codex, lui, expose à la fois un cumul
de session et un delta par tour — sommer le cumul multiplierait la
consommation par le nombre de tours.

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

## Confidentialité

Tout est local. Les journaux analysés contiennent votre code et vos
conversations : TRACE ne les envoie nulle part, et n'émet de requête réseau que
vers Anthropic ou OpenAI si — et seulement si — vous avez renseigné une clé
Admin.

- Le renderer n'a **aucun accès** au système de fichiers (`contextIsolation`
  actif, `nodeIntegration` désactivé, surface IPC énumérée explicitement).
- Les clés d'API sont chiffrées par le trousseau du système (`safeStorage`).
  Si le trousseau est indisponible, TRACE **refuse** d'enregistrer la clé
  plutôt que de l'écrire en clair.
- Index et préférences vivent dans le répertoire de configuration standard de
  la plateforme ; `config.json` est en `0600`.

---

## Architecture

```
src/
  core/          cœur métier — aucune dépendance à Electron, testable seul
    collectors/  une source = un module, isolé (une source en échec n'en bloque aucune autre)
    carbon/      estimateur EcoLogits + facteurs
    models.js    registre : tarifs, fenêtres de contexte, paramètres estimés
    ratelimits.js reconstruction des fenêtres et auto-calibrage
    aggregate.js coût et carbone calculés PAR MODÈLE puis sommés, jamais sur un tarif moyen
  main/          processus Electron : barre d'état, raccourci global, IPC, icônes PNG générées
  renderer/      popover et tableau de bord — HTML/CSS/JS natifs, SVG écrit à la main
  cli.js         les mêmes chiffres dans un terminal
```

L'indexation est incrémentale : chaque fichier est relu depuis un offset en
octets, et les lignes incomplètes — Claude Code écrit pendant qu'on lit — sont
reprises au passage suivant. Sur 116 Mo de journaux : **291 ms à froid, 18 ms
ensuite**.

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
intégré en base64 dans `src/renderer/shared/logos.js`. Les scripts `dist:*`
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

## Limites connues

- Les paramètres des modèles fermés sont estimés : la fourchette carbone couvre
  environ un ordre de grandeur. C'est irréductible sans publication des
  fournisseurs.
- Les tarifs sont figés dans `src/core/models.js` et doivent être mis à jour
  quand ils changent (surchargeables via `modelOverrides` dans la configuration).
- La pondération des limites de débit est une approximation : les vrais
  plafonds pondèrent aussi par modèle, selon une formule non publiée. D'où le
  calibrage manuel, qui court-circuite le problème en partant d'une valeur vraie.
- Gemini CLI et Ollama ne fournissent pas d'historique de tokens (voir plus haut).

## Licence

MIT
