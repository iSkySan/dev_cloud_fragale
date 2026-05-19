# FinSecure — Architecture Event-Driven & DevSecOps

## Vue d'ensemble

FinSecure est une fintech traitant 50 000 transactions/jour. Ce TP met en place :
- Un pipeline CI/CD sécurisé (Workload Identity + scan Trivy)
- Une architecture serverless event-driven (Pub/Sub + Cloud Functions)
- Un cache Redis via Cloud Memorystore pour réduire la charge DB

---

## Architecture Event-Driven — Pub/Sub → Cloud Function

```
Banque Partenaire
      │
      │ Webhook POST (transaction validée)
      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Google Cloud Platform                        │
│                                                                 │
│  ┌──────────────────┐    publish     ┌────────────────────────┐ │
│  │  API Gateway     │ ─────────────► │  Pub/Sub Topic         │ │
│  │  (GKE)           │                │  finsecure-payment-    │ │
│  └──────────────────┘                │  events                │ │
│                                      └──────────┬─────────────┘ │
│                                                 │               │
│                                     subscribe   │               │
│                                                 ▼               │
│                                      ┌──────────────────────┐   │
│                                      │  Subscription        │   │
│                                      │  finsecure-payment-  │   │
│                                      │  processor           │   │
│                                      │  (ack-deadline: 60s) │   │
│                                      │  (retention: 7 days) │   │
│                                      └──────────┬───────────┘   │
│                                                 │               │
│                              trigger (push)     │               │
│                                                 ▼               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Cloud Function Gen2                          │  │
│  │              finsecure-payment-processor                  │  │
│  │                                                           │  │
│  │  1. Décoder le message Pub/Sub (base64)                   │  │
│  │  2. Valider les champs obligatoires                       │  │
│  │  3. Accéder au secret DB via Secret Manager               │  │
│  │  4. Enregistrer la transaction (simulé Cloud SQL)         │  │
│  │  5. Émettre un log d'audit structuré (Cloud Logging)      │  │
│  │                                                           │  │
│  │  Runtime : Node.js 20 | Memory : 256Mi | Timeout : 60s   │  │
│  │  Min instances : 0 (scale to zero) | Max : 10            │  │
│  └──────────────┬──────────────────────────────┬────────────┘  │
│                 │                              │               │
│                 ▼                              ▼               │
│  ┌──────────────────────┐      ┌───────────────────────────┐   │
│  │  Secret Manager      │      │  Cloud Logging            │   │
│  │  finsecure-db-       │      │  (audit trail structuré)  │   │
│  │  password            │      └───────────────────────────┘   │
│  └──────────────────────┘                                      │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Dead Letter Topic : finsecure-payment-dead-letter       │  │
│  │  (messages en échec après 5 tentatives)                  │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Flux de traitement

| Étape | Composant | Description |
|-------|-----------|-------------|
| 1 | Banque → API Gateway | Webhook HTTP POST avec payload JSON (transaction validée) |
| 2 | API Gateway → Pub/Sub | Publication du message dans `finsecure-payment-events` |
| 3 | Pub/Sub → Cloud Function | Déclenchement automatique de `processPayment` |
| 4 | Cloud Function → Secret Manager | Récupération du mot de passe DB (Workload Identity) |
| 5 | Cloud Function → Cloud SQL | Enregistrement de la transaction (simulé) |
| 6 | Cloud Function → Cloud Logging | Log d'audit structuré JSON |
| Erreur | Pub/Sub → Dead Letter Topic | Après 5 tentatives échouées |

---

## Cache Redis — Benchmark avant/après

### Architecture Cache-Aside

```
Client HTTP
    │
    ▼
┌──────────────────────────────────────┐
│        finsecure-app (GKE)           │
│                                      │
│  GET /merchants                      │
│       │                              │
│       ▼                              │
│  ┌─────────────┐   HIT   ┌────────┐  │
│  │ withCache() │ ──────► │ Redis  │  │
│  │             │         │ 10.152 │  │
│  │             │  MISS   │ .135.83│  │
│  │             │ ──────► └────────┘  │
│  │             │                     │
│  │             │  fetch + setEx(3600)│
│  └──────┬──────┘                     │
│         │ MISS only                  │
│         ▼                            │
│  ┌─────────────┐                     │
│  │ Simulated   │  200ms wait         │
│  │ DB query    │  (Cloud SQL en prod)│
│  └─────────────┘                     │
└──────────────────────────────────────┘
```

### Résultats mesurés (GKE Autopilot, region europe-west9)

| Métrique | Sans cache (DB directe) | Avec cache (Redis) | Gain |
|---|---|---|---|
| Latence moyenne | 255 ms | 68 ms | **~4x** |
| Latence fastest | 250 ms | 50 ms | **5x** |
| Latence slowest | 265 ms | 208 ms | — |
| Requêtes/seconde | 3.9 | 114 | **~29x** |

> Redis Cloud Memorystore `finsecure-cache` — IP `10.152.135.83:6379` — tier BASIC 1GB

### Explication des gains

- **Sans cache** : chaque requête attend 200ms (latence DB simulée) + ~50ms réseau = ~255ms
- **Avec cache** : la donnée est retournée directement depuis Redis (~2ms) + ~50ms réseau = ~50ms
- **Invalidation** : `POST /merchants` appelle `invalidateCache('merchants:all')` → cohérence garantie
- **TTL** : 3600s (1h) — les données changent rarement, le TTL évite les données périmées si l'invalidation échoue

---

## Pipeline CI/CD — DevSecOps

```
push main
    │
    ▼
┌─────────┐    ┌────────────┐    ┌───────────────┐    ┌──────────┐
│  test   │───►│ build-push │───►│ security-scan │───►│  deploy  │
│ (kubeval│    │ (Docker +  │    │ (Trivy SARIF) │    │ (GKE)    │
│  lint)  │    │  push AR)  │    │ CRITICAL,HIGH │    │          │
└─────────┘    └────────────┘    └───────────────┘    └──────────┘
                    │                    │
                    ▼                    ▼
             Artifact Registry    GitHub Security
             (images taguées      (rapport SARIF
              par SHA commit)      uploadé)

Auth : Workload Identity Federation (pas de clé JSON)
SA   : finsecure-github-sa@ynov-cloud-theo.iam.gserviceaccount.com
```

---

## Cloud Scheduler — Tâches périodiques

```
Cloud Scheduler
├── finsecure-daily-reconciliation  (0 23 * * *)  Europe/Paris
│   └── pubsub → finsecure-scheduled-tasks → Cloud Function
│
└── finsecure-weekly-purge          (0 2 * * 0)   Europe/Paris
    └── pubsub → finsecure-scheduled-tasks → Cloud Function
```

---

## Budget GCP — Alertes configurées

| Seuil | Montant (budget 1500€/mois) | Action |
|-------|----------------------------|--------|
| 50%   | 750€                       | Email + Pub/Sub |
| 90%   | 1350€                      | Email + Pub/Sub |
| 100%  | 1500€                      | Email + Pub/Sub |

---

## Labels de ressources (FinOps)

| Ressource | team | environment | feature | cost-center |
|-----------|------|-------------|---------|-------------|
| GKE Cluster `tp3-cluster` | infra | dev | platform | engineering |
| Artifact Registry `tp3-app-registry` | infra | production | platform | — |
| Cloud Function `finsecure-payment-processor` | backend | production | payments | engineering |
| finsecure-app (Deployment) | backend | production | payments | — |

Pour facturation par client (`chargeback`) : ajouter label `client=boutiqueA/marketplaceB/ecommerceC` sur les ressources de traitement.
