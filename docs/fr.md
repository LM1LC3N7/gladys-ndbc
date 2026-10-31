# Bouées NDBC (NOAA)

Intégration non officielle : les observations des bouées et stations côtières du **National Data Buoy Center**
(NDBC, NOAA) dans Gladys : vagues, vent, températures de l'eau et de l'air, pression. Le NDBC couvre les côtes
des États-Unis, les Grands Lacs, le golfe du Mexique, Hawaï, l'Alaska et le Pacifique, et relaie quelques
bouées canadiennes (Environnement et Changement climatique Canada).

Les données viennent des fichiers temps réel publics du NDBC (sans compte ni clé) : données du gouvernement
américain, du domaine public (source : NOAA National Data Buoy Center), sauf les stations de partenaires que le
NDBC relaie, qui gardent les conditions de leur propriétaire (par exemple les bouées d'Environnement et
Changement climatique Canada, sous la Licence du gouvernement ouvert – Canada ; le propriétaire figure sur la
page NDBC de chaque station). **Cette intégration n'est pas une source officielle, et pas pour la
navigation** : consultez le NDBC et les prévisions marines officielles avant de sortir en mer. Elle n'a jamais
été testée sur une vraie installation Gladys par son auteur ; elle a été essayée contre les vrais fichiers du
NDBC.

## Ce que vous obtenez

Un appareil par station, nommé « Bouée NDBC 46026 » (renommez-le à votre guise dans Gladys). Tous les
appareils ont les mêmes 14 fonctions ; une variable que la station ne mesure pas n'a jamais de valeur (une
station côtière C-MAN n'a pas de vagues, beaucoup de bouées n'ont ni visibilité ni marée) :

| Fonction                                                | Colonne    | Unité                                                |
| ------------------------------------------------------- | ---------- | ---------------------------------------------------- |
| Direction du vent (degrés, d'où vient le vent)          | WDIR       | 0 à 360 (sans unité dans Gladys)                     |
| Vitesse du vent, rafale                                 | WSPD, GST  | m/s                                                  |
| Hauteur significative des vagues                        | WVHT       | m                                                    |
| Période dominante, période moyenne des vagues           | DPD, APD   | s                                                    |
| Direction des vagues (degrés, d'où viennent les vagues) | MWD        | 0 à 360 (sans unité dans Gladys)                     |
| Pression au niveau de la mer, tendance sur 3 h          | PRES, PTDY | hPa                                                  |
| Température de l'air                                    | ATMP       | °C                                                   |
| Température de l'eau, point de rosée                    | WTMP, DEWP | °C (type « sonde » : hors de la moyenne de la pièce) |
| Visibilité                                              | VIS        | km (depuis les milles marins, 1 nmi = 1,852 km)      |
| Niveau d'eau (marée)                                    | TIDE       | m (depuis les pieds, 1 ft = 0,3048 m)                |

Ce qui est publié, et quand :

- chaque fonction reçoit la **valeur la plus récente** de sa colonne parmi les lignes lues (une bouée envoie
  souvent le vent toutes les 10 minutes et les vagues toutes les 30 ou 60 minutes : chacune a sa propre heure) ;
- une valeur n'est publiée **que si son observation a moins de 2 heures**, l'âge étant pris par rapport à
  l'heure du serveur du NDBC (son en-tête `Date`, plus son `Age` quand la réponse est une copie gardée par le
  CDN), jamais par rapport à l'horloge de votre Gladys ;
- chaque observation est publiée **une fois** : l'heure de la dernière publiée pour chaque fonction est gardée
  dans `/data`, si bien que ni la lecture suivante ni un redémarrage ne la republient ; une observation plus
  ancienne n'est jamais publiée après une plus récente ;
- `MM` dans un fichier veut dire **manquant** : rien n'est publié, jamais 0. Une valeur hors de la plage
  plausible de sa variable (ou une valeur de remplissage « 9 » : 99, 999, 9999), ou une période de vagues de
  0 s, n'est pas une mesure non plus ;
- un appareil créé après une lecture reçoit tout de suite les valeurs de cette lecture qui ont encore moins
  de 2 heures ;
- dans l'historique de Gladys, une valeur est datée de sa publication, pas de son observation (jusqu'à environ
  une heure plus tard pour une station horaire) : l'heure de l'observation est dans le statut.

## Configuration

- **Identifiants des stations** : jusqu'à 10 identifiants de 4 ou 5 lettres ou chiffres (comme `46026`, `44025`, `KATP`,
  `PSBM1`), séparés par des virgules. Trouvez-les sur la carte du NDBC (https://www.ndbc.noaa.gov/). Une entrée
  qui n'est pas un identifiant est ignorée et signalée dans le statut ; au-delà de 10, les 10 premières sont
  lues.
- **Langue des noms** : anglais ou français, pour les noms proposés dans la découverte.
- **Intervalle de lecture** : de 10 à 180 minutes, 30 par défaut.

Après l'enregistrement, ouvrez la découverte pour créer les appareils.

## Rythme et courtoisie envers le NDBC

- une requête à la fois, au moins 3 s entre deux, avec un User-Agent qui nomme l'intégration ;
- seul le début de chaque fichier est demandé (`Range`, 16 Kio, environ 15 heures de lignes à 10 minutes) :
  jamais le fichier entier (jusqu'à 1 Mo). Un serveur qui ignorerait la plage est coupé au même endroit ;
- `If-None-Match` : un fichier lu depuis le lancement de l'intégration, inchangé depuis, répond 304 (rien de
  téléchargé) ;
- une série de lectures commence à chaque intervalle : ni une reconnexion à Gladys, ni une configuration
  enregistrée sans changement, ni la découverte, ni le bouton de test ne lisent plus tôt, ni un redémarrage
  tant que `/data` fonctionne (l'heure de la dernière tentative y est gardée ; si `/data` ne peut être ni lu
  ni écrit, un redémarrage attend 10 minutes, voir Limites). Les stations ajoutées à la liste sont lues seules
  tout de suite, au plus une fois par minute (les autres gardent leur tour), et une lecture en échec peut être
  refaite plus tôt (plus bas) ;
- un 429 (trop de requêtes) met toutes les lectures en pause 5 minutes, doublé s'il revient, 6 heures au plus,
  `Retry-After` respecté dans cette limite ; la pause est gardée dans `/data` et tient après un redémarrage ;
- un 5xx ou une autre réponse inattendue sur le fichier d'une station met cette station seule en retrait :
  relue 2 minutes plus tard, puis 4, 8… jusqu'à 6 heures (`Retry-After` respecté), pendant que les autres
  stations sont lues à leur rythme. Quand toutes les stations lues d'une série répondent ainsi, toutes les
  lectures sont aussi mises en pause 2 minutes (doublé, dans `/data`) ;
- une station dont la lecture a échoué pour une cause passagère (réseau, délai, pause) est relue avant la
  série suivante : à la fin de la pause, sinon 2 minutes plus tard, doublé à chaque nouvel échec, tant que cela
  tombe avant la série suivante ;
- une série interrompue par une configuration enregistrée ou une reconnexion garde la réponse de la requête
  partie ; les stations qu'elle n'avait pas encore lues sont lues juste après, pas à l'intervalle suivant ;
- une station sans fichier temps réel (404) est réessayée 1 heure plus tard, puis 2, 4… jusqu'à 24 heures, sur
  sa propre minuterie (les autres stations sont lues normalement).

## Statut

L'écran de configuration indique, pour chaque station : combien de valeurs ont moins de 2 heures et l'heure de
son observation la plus récente (UTC) ; ou « muette » quand sa valeur la plus récente a plus de 2 heures ; ou
« toutes les valeurs manquent (MM) » ; ou pourquoi la lecture a échoué (avec le statut HTTP) et ce que disait
la dernière bonne lecture, suivi de « rien publié depuis ». Quand une valeur atteint 2 heures, le statut est
mis à jour aussitôt, même entre deux lectures. Gladys montre l'intégration connectée seulement si la dernière
lecture d'au moins une station a donné une valeur de moins de 2 heures. Le bouton « Voir la dernière
lecture » donne le même texte et ne lit jamais.

## Limites

- Les fichiers du NDBC sont en quasi temps réel : une observation de bouée arrive en général dans le fichier
  10 à 60 minutes après avoir été faite, parfois plus. Une station qui n'envoie rien pendant 2 heures n'a rien
  de publié.
- Certaines bouées sont saisonnières (les bouées des Grands Lacs sont retirées l'hiver) : leur fichier
  s'arrête, la station devient « muette », puis le fichier peut disparaître (404).
- Les lignes des stations dans le statut sont raccourcies quand 10 stations n'y tiendraient pas (les lignes
  générales, prochaine lecture et avertissements sur `/data`, restent toujours).
- Une copie gardée par un cache et servie sans en-tête `Age` paraîtrait plus récente qu'elle ne l'est : ce
  n'est pas détectable (le CDN du NDBC envoie toujours `Age` ; vu jusqu'à environ 10 minutes).
- L'âge d'une observation demande l'heure du serveur du NDBC : une réponse sans `Date` lisible, ou à plus d'un
  jour de l'horloge de votre Gladys, ne publie rien (« l'heure du serveur est illisible »).
- Une colonne dont l'unité sur la deuxième ligne d'en-tête n'est pas celle attendue (des nœuds au lieu de m/s
  par exemple) n'est jamais utilisée, et le statut le dit.
- Si `/data` ne peut pas être lu (ou ne répond pas en 2 s), il est laissé tel quel et l'intégration tourne en
  mémoire : la première lecture attend 10 minutes après le démarrage, et un redémarrage peut republier une
  fois les observations les plus récentes.
- Au plus 250 valeurs sont publiées par minute : dans le cas rare où il y en aurait plus (10 stations et une
  rafale de créations d'appareils), le reste est publié à la lecture suivante s'il a encore moins de 2 heures.
- Seul le fichier météorologique standard (`.txt`) est lu : pas de spectre des vagues, pas de courants, pas
  de données DART (tsunami), ni de données océaniques ou de qualité de l'eau.
