# PRD — Multi-boards & page de board dédiée

**Produit** : Boardmine (extension Chrome MV3, vanilla JS, zéro build)
**Version cible** : 0.4.0
**Statut** : brouillon validé en session — prêt pour implémentation
**Tâches Google Tasks couvertes** :
- « Multi-dashboards : créer et alterner entre plusieurs tableaux » (UVc5MzJKWHJRQWJhWk5aQQ)
- « Avoir une page dédiée localement et pouvoir opt in / out de remplacer le New Tab avec un board spécifique » (S05WN0RSeWNQdjJROG1STg) — **partie « page dédiée » et « board spécifique » en v1 ; partie « opt-out » reportée en v2** (voir §9).

---

## 1. Contexte et problème

Aujourd'hui Boardmine ne connaît qu'un seul plateau : `chrome.storage.local.snippets` est une liste plate, `newtab.js` la charge intégralement et pose toutes les cartes sur un unique canvas. Le layout (`{x, y, w}`) est stocké dans le snippet lui-même.

Conséquences :
- Impossible de séparer des contextes (Pro / Perso / Crypto-Finance) : tout se mélange sur le New Tab.
- Le plateau n'est accessible que par le New Tab (`chrome_url_overrides.newtab`). On ne peut pas ouvrir « le board Finance » dans un onglet normal, ni en avoir deux côte à côte.

## 2. Objectifs

1. L'utilisateur peut créer autant de boards qu'il veut, les renommer, les supprimer.
2. Chaque snippet appartient à exactement un board (choisi au moment de la capture).
3. Le New Tab affiche toujours **un board désigné par l'utilisateur** (réglage persistant), quel que soit le dernier board consulté.
4. N'importe quel board peut s'ouvrir dans un onglet normal via une URL d'extension stable, et plusieurs onglets peuvent afficher des boards différents simultanément.
5. Migration transparente : les snippets existants atterrissent dans un board par défaut, l'export/import JSON continue de fonctionner.

## 3. Non-objectifs (v1)

- **Opt-out du remplacement du New Tab** (reporté, design en §9).
- Déplacer un snippet d'un board à un autre.
- Un snippet présent sur plusieurs boards.
- Réglages par board (intervalle, refresh conditionnel, couleur, icône…) — le modèle doit les permettre plus tard, mais aucun n'est livré.
- Refresh sélectif : **tous les snippets de tous les boards continuent d'être rafraîchis à leur intervalle**, affichés ou non (deviendra un réglage par board ultérieurement).
- Drag-and-drop entre boards, réordonnancement des boards (ordre = ordre de création).
- Conservation garantie des données existantes au-delà de la migration décrite (projet en phase test).

## 4. Personas et user stories

- **US1** — En tant qu'utilisateur, je crée un board « Finance » depuis le New Tab pour y regrouper mes graphiques crypto.
- **US2** — Je capture une zone d'une page ; le popup me propose le board cible (dernier board utilisé présélectionné) ; le snippet apparaît sur ce board.
- **US3** — Je passe d'un board à l'autre via un menu déroulant dans la barre du plateau.
- **US4** — Je désigne « Pro » comme board du New Tab ; chaque nouvel onglet l'affiche, même si j'ai consulté « Perso » juste avant.
- **US5** — J'ouvre « Perso » dans un onglet épinglé (URL stable), et « Pro » reste sur mes New Tab.
- **US6** — Je renomme ou supprime un board ; la suppression enlève ses snippets et leurs images après confirmation.
- **US7** — Après mise à jour de l'extension, mes anciens snippets sont tous dans un board « Main » et rien n'a bougé visuellement.

## 5. Modèle de données

### 5.1 Nouvelles clés `chrome.storage.local`

```js
// KEY_BOARDS = "boards"
boards: [
  { id: "default", name: "Main", createdAt: 1726650000000 },
  { id: "<uuid>",  name: "Finance", createdAt: ... },
]

// settings (existant) — nouveau champ
settings.newTabBoardId: "default"   // id du board affiché par le New Tab

// KEY_UI = "ui" — état d'interface non critique
ui.lastBoardId: "<id>"              // dernier board choisi dans le popup (présélection capture)
```

### 5.2 Snippet — nouveau champ

```js
snippet.boardId: "default"   // obligatoire après normalisation
```

Le `layout` reste porté par le snippet (un snippet = un board, donc une seule position).

### 5.3 Invariants (garantis par `storage.js`)

- Il existe toujours au moins un board. Le board `default` (nom « Main ») est créé à la volée par `getBoards()` si la liste est vide.
- `normalizeSnippet` force `boardId` : valeur absente, vide ou inconnue → `"default"`. L'id `"default"` est déterministe pour que la migration ne dépende d'aucun état ni ordre d'exécution (SW, New Tab et popup peuvent normaliser en parallèle).
- `getSettings()` force `newTabBoardId` sur un board existant (fallback : premier board).
- Supprimer le dernier board est refusé.
- Supprimer le board désigné New Tab → `newTabBoardId` bascule sur le premier board restant.

### 5.4 API `storage.js` à ajouter

```js
getBoards() → Board[]                // crée "default" si vide
getBoard(id) → Board|null
createBoard(name) → Board
renameBoard(id, name) → Board
deleteBoard(id) → { deletedSnippetIds }   // supprime snippets + meta ; l'appelant purge IndexedDB
getSnippetsForBoard(boardId) → Snippet[]
getUi() / patchUi(patch)
```

### 5.5 Migration

Aucune étape explicite : la normalisation paresseuse (§5.3) suffit. Au premier chargement de 0.4.0, tous les snippets sans `boardId` sont lus comme appartenant à `default`. `setSnippets`/`upsertSnippet` persistent le champ au premier écriture.

### 5.6 Export / import JSON

- Export passe en `version: 3` : `{ version, exportedAt, boards, snippets, settings }`.
- Import v3 : remplace boards, snippets, settings.
- Import v2 / v1 : `boards` absent → tous les snippets vont dans `default` (message d'info adapté).

## 6. Spécification par surface

### 6.1 Page de board (`newtab.html` / `newtab.js`) — sert à la fois de New Tab et de page dédiée

**Résolution du board affiché** :
1. Paramètre d'URL `?board=<id>` s'il est présent et valide.
2. Sinon `settings.newTabBoardId`.
3. Sinon premier board.

Le New Tab (ouvert par Chrome, sans paramètre) tombe donc toujours sur le board désigné (objectif 3). La page dédiée est `chrome-extension://<id>/newtab.html?board=<id>` — stable, favorisable, épinglable.

**Sélecteur de board (topbar, à gauche, après l'horloge)** : un bouton affichant le nom du board courant + chevron, ouvrant un menu déroulant :
- Liste des boards (ordre de création). Clic → bascule l'affichage **dans l'onglet courant** (re-rendu in-place, URL mise à jour via `history.replaceState` avec `?board=`). Ne modifie pas `newTabBoardId`.
- Sur chaque ligne, un **toggle « New Tab »** (icône radio/épingle) : marque ce board comme `newTabBoardId`. Un seul actif à la fois.
- Séparateur, puis : **« New board… »** (prompt inline pour le nom, création puis bascule dessus), **« Rename »** (board courant), **« Delete »** (board courant ; désactivé s'il ne reste qu'un board ; confirmation native `confirm()` indiquant le nombre de snippets supprimés).
- Style : même vocabulaire que le menu « ⋯ » des cartes (verre dépoli sombre).

**Rendu** : `load()` appelle `getSnippetsForBoard(currentBoardId)` au lieu de `getSnippets()`. `assignMissingLayouts` et `findFreeSpot` ne considèrent que les cartes du board courant. `updateRunStatus` compte les captures du board courant uniquement.

**« Refresh all »** : enfile uniquement les snippets du board courant (message `captureAll` avec `boardId`).

**Réactivité** : sur `storage.onChanged` pour `boards`, re-rendre le sélecteur ; si le board courant a été supprimé depuis un autre onglet, basculer sur `newTabBoardId`. Sur `snippets`, ne recharger que si un snippet du board courant est concerné (optimisation facultative ; recharger tout est acceptable).

**Titre de la page** : `<nom du board> — Boardmine`.

**État vide** : texte existant + nom du board (« Nothing on “Finance” yet »).

### 6.2 Popup (`popup.html` / `popup.js`)

- **Sélecteur de board** (`<select>`) au-dessus du bouton « Capture a zone of this page », présélectionné sur `ui.lastBoardId` (fallback `newTabBoardId`). Changer la valeur écrit immédiatement `ui.lastBoardId`.
- Au clic « Capture » : `ui.lastBoardId` est déjà persisté avant l'injection de `picker.js` (le popup se ferme ensuite, le SW lit la valeur au moment du `pickerResult`).
- **Liste des snippets** groupée par board (en-tête de groupe = nom du board + bouton « ↗ Open board » qui ouvre `newtab.html?board=<id>` dans un nouvel onglet).
- « Capture all » : inchangé, tous les boards.

### 6.3 Service worker (`background.js`)

- `handlePickerResult` : à la création, `boardId = message.boardId || ui.lastBoardId || settings.newTabBoardId`. `initialLayout` ne prend en compte que les layouts du board cible.
- Après création, l'onglet ouvert automatiquement devient `newtab.html?board=<boardId>` (au lieu de `chrome://newtab`), pour que l'utilisateur voie la carte apparaître même si ce board n'est pas celui du New Tab.
- `captureAll` accepte un `boardId` optionnel : présent → snippets de ce board ; absent → tous.
- `enqueueStale`, alarmes, `refreshIfStale` : **inchangés**, tous boards confondus (§3).
- Nouveau message `deleteBoard` (ou traitement côté page) : la suppression des images IndexedDB des snippets retirés doit être faite par la page qui supprime (`newtab.js` ou `options.js`), comme pour `deleteSnippet` aujourd'hui.

### 6.4 Page Settings (`options.html` / `options.js`)

- **Filtre de board** (`<select>` « All boards / Main / Finance…») au-dessus de la liste des snippets ; chaque ligne affiche le nom de son board en badge.
- **Formulaire snippet** : champ « Board » (`<select>`) — modifiable **uniquement à la création** (« New snippet ») ; en édition, affiché en lecture seule (pas de déplacement en v1).
- Section **Boards** (nouveau panneau, léger) : liste des boards avec rename / delete, création, et radio « Used on New Tab ». Fonctionnellement redondant avec le menu du plateau, mais donne une vue de gestion.
- Export/import : §5.6.

### 6.5 Picker (`picker.js`)

Aucun changement : le board cible est résolu côté SW via `ui.lastBoardId`.

## 7. Cas limites

| Cas | Comportement |
|---|---|
| `?board=` inconnu | Ignorer, afficher `newTabBoardId`, nettoyer l'URL. |
| Suppression du dernier board | Refusée (bouton désactivé + garde côté storage). |
| Suppression du board New Tab | `newTabBoardId` → premier board restant. |
| Deux onglets sur le même board, drag en cours dans l'un | Comportement existant (`pendingReload`) conservé. |
| Board supprimé alors qu'il est affiché dans un autre onglet | Cet onglet bascule sur `newTabBoardId` au `storage.onChanged`. |
| Nom de board vide ou doublon | Vide → refusé ; doublon → autorisé (ids distincts). Longueur max 40 caractères. |
| Import v2 avec snippets sans `boardId` | Tous dans `default`. |
| `ui.lastBoardId` pointe sur un board supprimé | Fallback `newTabBoardId`. |

## 8. Critères d'acceptation

1. Installer 0.4.0 par-dessus 0.3.0 : le New Tab affiche exactement les mêmes cartes, aux mêmes positions, dans un board nommé « Main ».
2. Créer « Finance » depuis le menu du plateau : le plateau bascule sur un board vide, l'URL contient `?board=`.
3. Ouvrir un nouvel onglet : « Main » s'affiche (pas « Finance »).
4. Activer le toggle New Tab sur « Finance », ouvrir un nouvel onglet : « Finance » s'affiche.
5. Popup : sélectionner « Finance », capturer une zone ; la carte apparaît sur « Finance », pas sur « Main » ; le popup rouvert présélectionne « Finance ».
6. Deux onglets ouverts sur deux boards différents affichent des cartes différentes ; déplacer une carte dans l'un ne modifie pas l'autre.
7. « Refresh all » sur « Finance » n'enfile que les snippets de « Finance » ; le rafraîchissement périodique continue pour tous.
8. Supprimer « Finance » (avec 2 snippets) : confirmation mentionnant 2 snippets ; snippets, meta et images IndexedDB supprimés ; onglet basculé sur « Main ».
9. Export JSON v3 puis « Clear » + import : boards, snippets et `newTabBoardId` restaurés. Import d'un export v2 : tout dans « Main ».
10. Aucune nouvelle permission dans `manifest.json` ; toujours zéro build.

## 9. Reporté en v2 — opt-out du remplacement du New Tab

L'override `chrome_url_overrides.newtab` est statique en MV3 (impossible à activer/désactiver par code). Design retenu (option a) :
- Réglage `settings.newTabMode: "board" | "chrome"`.
- En mode `chrome`, `newtab.html` sans paramètre `?board=` exécute immédiatement `location.replace("chrome://new-tab-page")` avant tout rendu (script inline en tête de `<head>`, ou premier statement du module). Un flash bref est accepté.
- La page dédiée (`?board=`) reste toujours fonctionnelle, quel que soit le mode.
- Le toggle vivra dans le menu du sélecteur de board et dans Settings.

Le modèle et l'URL définis en v1 sont déjà compatibles.

## 10. Plan d'implémentation — tâches scopées (agents)

Chaque tâche est autonome, référencée aux fichiers, et vérifiable. T1 est fondatrice ; T2, T3, T4 sont parallélisables ensuite.

**T1 — Modèle de données, migration, export/import** (`storage.js`, `options.js` partie export/import)
- Ajouter `KEY_BOARDS`, `KEY_UI`, `boardId` dans `DEFAULT_SNIPPET`/`normalizeSnippet`, `newTabBoardId` dans settings, l'API §5.4, les invariants §5.3.
- Export v3 + import v1/v2/v3.
- Vérification : charger l'extension, ouvrir la console du SW, `getBoards()` renvoie `[{id:"default",name:"Main"}]`, `getSnippets()[0].boardId === "default"`.

**T2 — Page de board** (`newtab.html`, `newtab.js`, `newtab.css`)
- Résolution du board (§6.1), sélecteur/menu avec create/rename/delete/toggle New Tab, filtrage des cartes, `Refresh all` scoped, réactivité `storage.onChanged`, titre de page, état vide.
- Vérification : critères 2, 3, 4, 6, 8.

**T3 — Popup + service worker** (`popup.html`, `popup.js`, `popup.css`, `background.js`)
- Sélecteur de board + `ui.lastBoardId`, liste groupée + « Open board », `handlePickerResult` avec `boardId` et ouverture de `newtab.html?board=`, `captureAll` avec `boardId` optionnel, `initialLayout` scoped.
- Vérification : critères 5, 7.

**T4 — Settings** (`options.html`, `options.js`, `options.css`)
- Filtre de board sur la liste, badge board, champ Board dans le formulaire (création seulement), panneau Boards.
- Vérification : critère 9 + gestion des boards depuis Settings.

**T5 — Intégration et QA** : passer les 10 critères, bump `manifest.version` → 0.4.0, mettre à jour le README (section Use + Architecture), vérifier l'absence de régression sur le drag/resize/snapping.
