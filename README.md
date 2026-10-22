# Diff Checker

Un comparateur de texte précis, pensé pour repérer, parcourir et fusionner les différences sans perdre le contexte du document.

[Voir la démo](https://diffchecker.ananaba.be) · [Découvrir la Toolbox](https://ananaba.be/applications/)

![Aperçu de Diff Checker](https://ananaba.be/assets/app-diffchecker.svg)

## Fonctionnalités

- comparaison ligne par ligne en temps réel ;
- navigation entre chaque différence ;
- fusion bidirectionnelle, changement par changement ;
- suppressions en rouge, ajouts en vert et passerelles visuelles entre les deux versions ;
- numéros de ligne et mini-carte navigable avec fenêtre de lecture déplaçable ;
- comparaison optimisée pour les documents de plusieurs milliers de lignes ;
- import et téléchargement de fichiers `.txt` ;
- raccourcis clavier et interface responsive.

## Lancer le projet

```bash
docker compose up -d --build
```

Puis ouvrir `http://127.0.0.1:8788`.

## Stack

HTML, CSS et JavaScript sans dépendance, servis par Nginx dans Docker.

Projet conçu par [Elliot Ananaba](https://ananaba.be).
