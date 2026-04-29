# TP 2 — Docker Avancé, Cloud Run & Networking GCP

Application Node.js + TypeScript avec Docker Compose, PostgreSQL, Redis, déployée sur Google Cloud Platform

Date : 07/04/2026 | Plateforme : Google Cloud Platform | Durée TP : 3 h

---

## Table des matières

1. Vue d'ensemble
2. Architecture
3. Prérequis
4. Installation locale
5. Commandes principales
6. Déploiement sur Cloud Run
7. Structure du projet
8. Points clés du TP
9. Troubleshooting

---

## Vue d'ensemble

Ce TP démontre les meilleures pratiques du développement cloud :

- Dockerfile multi-stage pour réduire la taille des images (202 MB vers 139 MB, -31%)
- Docker Compose pour orchestrer une stack multi-services (App + PostgreSQL + Redis)
- Google Artifact Registry pour stocker les images Docker en privé
- Cloud Run pour déployer sans gérer l'infrastructure
- VPC + Firewall pour sécuriser le réseau GCP
- Cache Redis avec TTL pour optimiser les performances
- Traffic Splitting pour déployer progressivement (canary deployment)

---

## Architecture

### Diagramme local (Docker Compose)

```
┌─────────────────────────────────────────────────────┐
│            Docker Compose Stack                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────┐    ┌──────────────┐             │
│  │   Node.js    │    │   PostgreSQL │             │
│  │   Express    │───→│   Port 5432  │             │
│  │   Port 8080  │    │   ynov_db    │             │
│  └──────┬───────┘    └──────────────┘             │
│         │                                          │
│         │ (Redis cache)                           │
│         ▼                                          │
│  ┌──────────────┐                                 │
│  │   Redis 7    │                                 │
│  │   Port 6379  │                                 │
│  │   128 MB RAM │                                 │
│  └──────────────┘                                 │
│                                                   │
│  Network: app-network (bridge driver)            │
└─────────────────────────────────────────────────────┘
```

### Diagramme Cloud Run (Production)

```
┌─────────────────────────────────────────┐
│         Internet (0.0.0.0/0)            │
│  https://tp2-service-xxx-ew.a.run.app   │
└────────────────┬────────────────────────┘
                 │ HTTP/HTTPS
                 ▼
        ┌──────────────────┐
        │    Firewall      │
        │  tp2-allow-http  │
        │  tp2-allow-https │
        └────────┬─────────┘
                 ▼
        ┌──────────────────┐
        │    Cloud Run     │
        │   tp2-service    │
        │ Max: 3 instances │
        │ Memory: 512 MB   │
        │ CPU: 1 vCPU      │
        └──────────────────┘
        
Note: Cloud Run ne se connecte PAS à PostgreSQL local
      (erreur attendue sur /db)
```

---

## Prérequis

Local (WSL/Linux/Mac):
- Docker et Docker Compose
- Node.js 20+ et npm
- TypeScript (npm install -g typescript)

Google Cloud Platform:
- Compte GCP actif avec billing activé
- gcloud configuré et authentifié
- Région par défaut : europe-west9 (Paris)

Vérifier les installations :

```bash
docker --version
docker-compose --version
node --version
npm --version
gcloud --version
gcloud auth list
```

---

## Installation locale

### Étape 1 : Cloner et se positionner

```bash
cd tp_cloud/tp2-app
```

### Étape 2 : Installer les dépendances

```bash
npm install
npm install --save-dev @types/pg @types/express
npm install redis pg
```

### Étape 3 : Compiler TypeScript

```bash
npm run build
```

### Étape 4 : Lancer la stack Docker Compose

```bash
docker-compose up -d --build
```

Attendre 5-10 secondes que PostgreSQL initialise la DB...

### Étape 5 : Vérifier que tout fonctionne

```bash
# Vérifier les services
docker-compose ps

# Tester les endpoints
curl http://localhost:8080/
curl http://localhost:8080/health
curl http://localhost:8080/db        # Crée la table "visits"
curl http://localhost:8080/cached    # Teste le cache Redis
```

Résultat attendu :

```json
{"message":"Hello from YNOV Cloud TP2","version":"2.1.0"}
{"status":"ok","database":"connected"}
{"total_visits":1,"source":"database"}
{"total_visits":1,"source":"cache","ttl_remaining":9}
```

---

## Commandes principales

### Docker Compose

```bash
# Démarrer la stack
docker-compose up -d --build

# Voir l'état des services
docker-compose ps

# Voir les logs en temps réel
docker-compose logs -f web    # Logs de l'app
docker-compose logs -f db     # Logs de PostgreSQL
docker-compose logs -f cache  # Logs de Redis

# Arrêter sans supprimer les volumes (données conservées)
docker-compose stop

# Arrêter ET supprimer les volumes (reset complet)
docker-compose down -v

# Exécuter une commande dans un conteneur
docker-compose exec web npm run build
```

### Docker Images

```bash
# Lister les images
docker images | grep tp2

# Construire l'image
docker build -t tp2-app:v1 .

# Tagger pour Artifact Registry
PROJECT_ID=$(gcloud config get-value project)
docker tag tp2-app:v1 europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/tp2-app:v1

# Pousser vers Artifact Registry
docker push europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/tp2-app:v1
```

### Tests de cache Redis

```bash
# Première requête - source: "database" (cache miss)
curl http://localhost:8080/cached

# Requêtes suivantes (< 10 sec) - source: "cache" (cache hit)
curl http://localhost:8080/cached
curl http://localhost:8080/cached

# Attendre 11 secondes et relancer - source: "database" (cache expiré)
sleep 11 && curl http://localhost:8080/cached
```

---

## Déploiement sur Cloud Run

### Étape 1 : Configurer le projet GCP

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud config get-value project  # Vérifier
```

### Étape 2 : Créer un repository Artifact Registry

```bash
gcloud artifacts repositories create tp2-registry \
  --repository-format=docker \
  --location=europe-west9 \
  --description="Registry TP2 YNOV"

# Vérifier
gcloud artifacts repositories list
```

### Étape 3 : Authentifier Docker

```bash
gcloud auth configure-docker europe-west9-docker.pkg.dev

# Si erreur docker-credential-gcloud, utiliser une clé de service :
PROJECT_ID=$(gcloud config get-value project)
gcloud iam service-accounts create tp2-docker-pusher
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:tp2-docker-pusher@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
gcloud iam service-accounts keys create /tmp/tp2-key.json \
  --iam-account=tp2-docker-pusher@${PROJECT_ID}.iam.gserviceaccount.com
cat /tmp/tp2-key.json | docker login -u _json_key --password-stdin europe-west9-docker.pkg.dev
```

### Étape 4 : Pousser l'image

```bash
PROJECT_ID=$(gcloud config get-value project)
IMAGE_TAG="europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/tp2-app:v1"

docker build -t tp2-app:v1 .
docker tag tp2-app:v1 ${IMAGE_TAG}
docker push ${IMAGE_TAG}

# Vérifier
gcloud artifacts docker images list europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry
```

### Étape 5 : Déployer sur Cloud Run

```bash
PROJECT_ID=$(gcloud config get-value project)
IMAGE="europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/tp2-app:v1"

gcloud run deploy tp2-service \
  --image=${IMAGE} \
  --region=europe-west9 \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=512Mi \
  --cpu=1 \
  --max-instances=3 \
  --set-env-vars="APP_ENV=production"
```

### Étape 6 : Récupérer l'URL et tester

```bash
SERVICE_URL=$(gcloud run services describe tp2-service \
  --region=europe-west9 --format='value(status.url)')

echo "URL : ${SERVICE_URL}"

# Tester
curl ${SERVICE_URL}/
curl ${SERVICE_URL}/health
```

### Étape 7 : Traffic Splitting (déploiement canary)

```bash
# Déployer une nouvelle révision sans trafic
gcloud run deploy tp2-service \
  --image=${IMAGE} \
  --region=europe-west9 \
  --no-traffic \
  --set-env-vars="APP_ENV=production,APP_VERSION=2.0.0" \
  --tag=v2

# Router 80% vers stable, 20% vers canary
REV_STABLE=$(gcloud run revisions list --service=tp2-service --region=europe-west9 --format="value(name)" | sed -n '2p')
REV_CANARY=$(gcloud run revisions list --service=tp2-service --region=europe-west9 --format="value(name)" | sed -n '1p')

gcloud run services update-traffic tp2-service \
  --region=europe-west9 \
  --to-revisions="${REV_STABLE}=80,${REV_CANARY}=20"

# Après validation : 100% vers canary
gcloud run services update-traffic tp2-service \
  --region=europe-west9 \
  --to-latest
```

---

## Structure du projet

```
tp2-app/
├── src/
│   └── index.ts                 # Application Node.js + Express + Redis
├── dist/                        # (généré) Code compilé TypeScript
├── package.json                 # Dépendances npm
├── tsconfig.json               # Configuration TypeScript
├── Dockerfile                  # Multi-stage build (production)
├── Dockerfile.naive            # Build simple (pour comparaison)
├── docker-compose.yml          # Stack : App + PostgreSQL + Redis
├── .dockerignore               # Exclusions du build
├── lifecycle.json              # Règles Cloud Storage
├── README.md                   # Ce fichier
├── screen/                     # Captures d'écran livrables
│   ├── taille_build.png        # docker images (réduction 31%)
│   └── screen_console.png      # Cloud Run console
└── tp2.md                      # Énoncé du TP complet
```

---

## Points clés du TP

### 1. Docker Multi-Stage Build

Problème : Image naïve = 202 MB (compilateur, devDependencies inutiles)
Solution : 2 stages = 139 MB (-31%)

```dockerfile
# Stage 1 : Compilation
FROM node:20-alpine AS builder
RUN npm install  # Installe tout (dev + prod)
RUN npm run build

# Stage 2 : Runtime
FROM node:20-alpine
COPY --from=builder /app/dist ./dist
RUN npm ci --omit=dev  # Que les dépendances prod
```

Bénéfice : Moins de code = moins de vulnérabilités = plus rapide à déployer

### 2. Docker Compose avec PostgreSQL

Services :
- web : Application Node.js (port 8080)
- db : PostgreSQL (port 5432)
- cache : Redis (port 6379)

Réseau dédié : app-network (bridge)
Healthchecks : Attend que DB soit prête avant de lancer l'app

### 3. Cache Redis avec TTL

Pattern :

```typescript
// 1. Chercher dans Redis (5ms)
const cached = await redis.get('visit_count')
if (cached) return cached

// 2. Cache miss : requête DB (100ms)
const data = await db.query(...)

// 3. Stocker dans Redis avec TTL=10s
await redis.setEx('visit_count', 10, data)
```

Bénéfice : 20x plus rapide après le premier appel

### 4. Traffic Splitting (Canary Deployment)

Progression :
- T=0 : 20% vers canary (test)
- T=5min : 50% vers canary (si OK)
- T=15min : 100% vers canary (promotion)

Avantage : Détecte les bugs sur 20% d'utilisateurs, pas 100%

### 5. VPC + Firewall GCP

Subnets :
- tp2-subnet-public (10.10.1.0/24) : App exposée à internet
- tp2-subnet-private (10.10.2.0/24) : DB isolée

Règles :
- HTTP/HTTPS depuis 0.0.0.0/0 vers app
- PostgreSQL depuis internet bloqué
- PostgreSQL depuis app uniquement

---

## Troubleshooting

### Docker Compose : "relation 'visits' does not exist"

Cause : Table PostgreSQL non créée

Solution : Vérifier que pool.query(CREATE TABLE IF NOT EXISTS...) est exécuté au démarrage

```typescript
// Dans index.ts, après la création du pool
pool.query(`
  CREATE TABLE IF NOT EXISTS visits (
    id SERIAL PRIMARY KEY,
    visited_at TIMESTAMP DEFAULT NOW()
  )
`).catch(console.error);
```

### Cloud Run : "/db" retourne erreur de connexion

Cause : Cloud Run ne peut pas accéder à PostgreSQL local

Solution : C'est normal ! Le TP utilise Cloud Run avec une image de test. En production, utiliser Cloud SQL.

### Docker push : "docker-credential-gcloud: executable not found"

Cause : Credential helper gcloud manquant sur WSL

Solution : Utiliser une clé de service JSON au lieu du credential helper

```bash
cat /tmp/tp2-key.json | docker login -u _json_key --password-stdin europe-west9-docker.pkg.dev
```

### gcloud : "Error: You do not have permission to modify the GCP SDK"

Cause : Permissions insuffisantes pour installer les composants

Solution : Utiliser google-cloud-cli via snap (avec --classic)

```bash
sudo snap install google-cloud-cli --classic
```

### Redis : "Cache miss" toujours affiché

Cause : Redis n'est pas connecté ou clé pas stockée

Solution : Vérifier les logs Redis

```bash
docker-compose logs cache
redis-cli -h localhost ping  # Doit répondre PONG
```

---

## Résultats attendus

### Images Docker

```bash
$ docker images | grep tp2
tp2-naive:v1      202 MB  <- Image naïve
tp2-app:v1        139 MB  <- Image multi-stage (-31%)
```

### Tests locaux

```bash
$ curl http://localhost:8080/
{"message":"Hello from YNOV Cloud TP2","version":"2.1.0"}

$ curl http://localhost:8080/cached
{"total_visits":0,"source":"database"}  # 1er appel

$ curl http://localhost:8080/cached
{"total_visits":0,"source":"cache","ttl_remaining":8}  # Hit
```

### Cloud Run

```
Service URL: https://tp2-service-573328088364.europe-west9.run.app/
Status: Active
Max instances: 3
Memory: 512 Mi
CPU: 1 vCPU
```
