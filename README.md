# Open ERP

A sector-agnostic operations platform: CRM and sales pipeline, projects and tasks,
FP&A and invoicing, fundraising and cap table, contacts and communications,
marketing campaigns, client portals, and a partner/learning programme.

Open ERP is the core-operations half of a larger platform, re-derived with every
scientific and laboratory module removed. There is no ELN, no protocol bank,
no inventory of chemicals or equipment, and no domain-specific modelling —
only infrastructure that applies to any organisation.

**License:** Business Source License 1.1 (see [LICENSE](LICENSE))

---

## Stack

| Layer | Technology |
|---|---|
| API | FastAPI (Python) + Uvicorn |
| Frontend | Next.js 14 (App Router) |
| Database | PostgreSQL 16 + pgvector |
| Queue / Cache | Redis 7 + Celery |
| AI | Anthropic Claude + OpenAI embeddings |
| Proxy | Traefik |

---

## Quick start

```bash
git clone https://github.com/elliott-symbiobc/collective-erp.git
cd collective-erp
cp .env.example .env        # fill in your keys
docker compose up -d
```

The frontend is served at `http://localhost:8080`. On first start the API
applies `sql/schema.sql` to an empty database.

Deploying to Railway uses `api/railway.toml` and `frontend/railway.toml`.

---

## Modules

**Revenue** — CRM pipeline, sales leads, deals and stage history, contacts with
relationship inference and Google/Gmail sync, marketing campaigns and email
templates, scheduled sends and deliverability tracking.

**Delivery** — projects with templates and milestones, tasks with assignees,
dependencies and review requests, time tracking, daily and weekly planners,
client portals and data rooms.

**Finance** — FP&A models and scenarios, Plaid and QuickBooks actuals,
invoicing and payables, fundraising pipeline, investor CRM, and cap table.

**Organisation** — users and roles, a partner programme with a default-deny
permission cascade, a learning centre, an activity audit log, notifications,
messaging channels, and a knowledge base.

---

## Layout

```
api/
  app/
    main.py            FastAPI entry point, router wiring, DB bootstrap
    routers/           one module per feature area
    agents/            LLM agents (lead scoring, enrichment, discovery)
    core/              activity log, partner guard, impersonation, RAG
    tasks/             Celery tasks (contacts sync, embeddings, comms)
    worker.py          Celery app and beat schedule
frontend/
  app/                 Next.js routes
  components/          shared UI
  lib/                 client helpers, roles, formatting
sql/
  schema.sql           complete database schema; apply to an empty database
scripts/               backup, health check, Odoo import helpers
```

---

## Configuration

Copy `.env.example` to `.env`. At minimum set `DATABASE_URL`, `REDIS_URL`,
`NEXTAUTH_SECRET`, and `NEXTAUTH_URL`. Integrations (Google, Plaid,
QuickBooks, Stripe, Anthropic, OpenAI) are optional — the modules that use
them degrade rather than fail when their keys are absent.
