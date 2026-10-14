# APsystems EZ1

**Connecteur non officiel, sans lien avec APsystems.** Il lit vos
micro-onduleurs APsystems EZ1 (solaire de balcon : EZ1-M, et les autres
modèles EZ1 qui offrent l'API locale) sur votre réseau local, via l'API
locale que l'onduleur ouvre lui-même : ni cloud ni compte, rien ne sort de
chez vous. APsystems est une marque d'Altenergy Power System Inc.

## Ce que vous obtenez

| Surface                  | Contenu                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Un appareil par onduleur | **puissance produite** (W, totale et par panneau), **énergie du jour** (kWh), **énergie totale** (kWh, un index de production pour le suivi énergétique de Gladys, avec sa production par tranche de 30 minutes), **limite de puissance** (W, réglable), **marche/arrêt**, **joignable**, **alarmes** |
| Déclencheurs de scène    | **production solaire démarrée** (le matin), **production solaire arrêtée** (le soir), **alarme d'onduleur solaire** (hors réseau, défaut de sortie, court-circuit DC sur un panneau)                                                                                                                  |
| Actions de scène         | **régler la limite de puissance solaire** d'un onduleur, **lire la production solaire** (puissance, énergie du jour et totale, d'un onduleur ou de tous)                                                                                                                                              |
| Widget                   | **Production solaire** : puissance actuelle, énergie du jour et totale, par panneau, la limite et l'état d'un onduleur, ou le total de tous                                                                                                                                                           |

## Installation

1. **Activez l'API locale** de chaque onduleur, une fois : dans
   l'application **AP EasyPower**, connectez-vous à l'onduleur (Bluetooth,
   « Connexion directe »), ouvrez **Réglages → Mode local**, activez-le et
   choisissez **Continu**. L'application affiche l'adresse IP de l'onduleur.
2. Dans votre box, donnez à chaque onduleur une **adresse fixe**
   (réservation DHCP) : l'intégration retrouve les onduleurs par leur
   adresse.
3. Dans Gladys, saisissez les adresses dans **Adresses des onduleurs**,
   séparées par des virgules : `192.168.1.50, 192.168.1.51`. Le port est
   8050 ; ajoutez `:port` seulement si le vôtre est différent.
4. Enregistrez, puis cliquez sur **Tester les onduleurs** : chaque adresse
   répond avec son modèle, son numéro de série, son firmware et sa
   puissance actuelle. **Faites-le de jour** : un EZ1 dort la nuit.
5. Ouvrez **Découverte** et ajoutez les onduleurs. Placez le widget
   **Production solaire** sur un tableau de bord : choisissez un onduleur,
   ou laissez vide pour le total de tous.

Chaque onduleur est lu toutes les 30 secondes (option **Intervalle de
rafraîchissement**, 10 s minimum : l'EZ1 répond lentement) ; ses alarmes et
sa marche/arrêt toutes les 5 minutes, ses informations et sa limite de
puissance toutes les heures.

## La nuit

Un EZ1 est alimenté par ses panneaux : sans soleil il s'éteint, Wi-Fi
compris. C'est normal et **pas une erreur** : après trois lectures sans
réponse, l'onduleur est affiché **en veille (nuit)**, sa puissance passe à
0 W, ses compteurs d'énergie gardent leur valeur, et il n'est plus essayé
que toutes les 5 minutes jusqu'à son réveil. Le statut de connexion reste
vert.

Le statut ne passe au rouge que si un onduleur disparaît **en pleine
production** (au moins 50 W à sa dernière réponse), ou reste muet une
journée entière : vérifiez alors son Wi-Fi, son adresse, et que le mode
local est toujours activé.

L'**énergie du jour** est le compteur de l'onduleur depuis son réveil ce
matin ; elle garde la valeur du soir pendant la nuit et repart au lever du
soleil. Un redémarrage de l'onduleur dans la journée (un nuage très sombre)
est additionné, pas perdu.

## Suivi de l'énergie

La fonctionnalité **énergie totale** est un index de production : Gladys le
transforme en production par tranche de 30 minutes (la fonctionnalité
« Lifetime energy (30-minute production) », que Gladys remplit elle-même)
pour ses écrans d'énergie. L'index ne fait jamais de chute suivie d'une
remontée : une lecture basse isolée (un raté au réveil) est ignorée, pour
qu'elle ne soit jamais comptée deux fois comme production.

## Limite de puissance et marche/arrêt

- **Limite de puissance** : plafonne la production, dans les bornes que
  l'onduleur annonce (30 à 800 W sur un EZ1-M). L'intégration ne l'écrit
  jamais d'elle-même, et ne réécrit pas une valeur que l'onduleur a déjà.
  APsystems ne dit pas si l'onduleur la garde en mémoire : une scène qui la
  change toutes les quelques secondes n'est pas une bonne idée, une fois
  toutes les quelques minutes suffit largement.
- **Marche/arrêt** : arrête ou relance la production ; l'API locale
  continue de répondre onduleur arrêté. Certains firmwares (ceux qui
  finissent par `_b`, pour les systèmes avec batterie) n'ont pas de
  marche/arrêt : la fonctionnalité n'est alors pas proposée.

## Scènes

- **Production solaire démarrée** : un onduleur a produit 10 W ou plus
  pendant une minute. Variables : la puissance et l'énergie du jour jusque-là.
- **Production solaire arrêtée** : sous 5 W pendant 15 minutes, ou en
  veille. Variable : `{{triggerEvent.data.energy_today}}`, l'énergie du
  jour (le bon moment pour un message « production du jour »).
- **Alarme d'onduleur solaire** : une alarme s'est levée : **hors réseau**
  (vérifiez le raccordement AC), **défaut de sortie** (le raccordement AC
  aussi), **court-circuit DC** (vérifiez le connecteur du panneau de cette
  entrée, `{{triggerEvent.data.input}}`). La première lecture après le
  démarrage ou après la nuit ne déclenche rien : l'onduleur vérifie le
  réseau chaque matin.

Dans chaque déclencheur, choisissez un onduleur ou laissez vide pour
n'importe lequel. Les variables contiennent toujours le nom de l'onduleur,
`{{triggerEvent.data.name}}`, et son numéro de série,
`{{triggerEvent.data.serial}}`.

- L'action **régler la limite de puissance solaire** prend un onduleur et
  une valeur en W, et donne `{{limit}}`, la limite appliquée.
- L'action **lire la production solaire** prend un onduleur, ou aucun pour
  tous, et donne `{{power}}` (W), `{{energy_today}}` et `{{energy_total}}`
  (kWh), `{{producing}}`, `{{sleeping}}` et `{{inverters}}` (le nombre
  d'onduleurs comptés), pour un message ou une condition. Elle utilise les
  dernières lectures ; seul un onduleur pas encore lu depuis le démarrage est
  lu d'abord.

## Dépannage

- **Pas de réponse de jour** : vérifiez l'adresse (une adresse fixe), que
  le mode local est activé et réglé sur « Continu », et que Gladys peut
  joindre le réseau de l'onduleur (l'intégration tourne dans un conteneur
  sur l'hôte Gladys).
- **« …does not answer: it sleeps without sun »** sur une commande :
  l'onduleur dort ; réessayez quand il produit.
- **Pas de marche/arrêt** : le firmware n'en a pas (voir plus haut).
- **L'énergie totale a baissé** : certains firmwares remettent ce compteur
  à zéro ; une lecture basse isolée est ignorée, une baisse durable est
  publiée.
- Logs : le niveau de log de l'intégration se règle avec la variable
  `LOG_LEVEL`.

## Confidentialité

Tout reste sur votre réseau local : l'intégration ne parle qu'aux adresses
que vous avez saisies, en HTTP sur le port 8050.
