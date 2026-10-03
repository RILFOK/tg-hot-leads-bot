# Telegram Hot Leads Bot

[![CI](https://github.com/RILFOK/tg-hot-leads-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/RILFOK/tg-hot-leads-bot/actions/workflows/ci.yml)
![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7.10-2D3748?logo=prisma&logoColor=white)

A **Telegram lead-monitoring bot** for detecting potential web-development enquiries in source chats and delivering relevant leads to an owner or individual subscribers. It uses transparent, weighted text rules rather than an external AI service.

> **Project status:** public portfolio source code; development is ongoing. This is not a hosted demo or a turnkey production deployment.

## Features

- **Rule-based lead detection:** positive and negative Russian-language signals, configurable minimum score (0–10), and categories for websites, landing pages, online stores and support requests.
- **Separate lead scopes:** the owner's global web-development detector and each subscriber's personal phrase triggers have independent lead records and delivery state.
- **Source and trigger management:** connect/disconnect source chats, manage phrases, respect subscription limits and route matching messages to the configured notification chat.
- **Lead workflow:** deduplication, repeated-trigger tracking, spam guard, hot-lead timing, status changes, notes, archive, trash and restore operations.
- **Owner administration:** user/subscription management, statistics, banned users, blocked source chats and blacklisted phrases.
- **Subscriptions and payments:** Trial, Start, Pro and owner access; Telegram Stars invoices with pre-checkout validation, payment-event deduplication and transactional subscription activation. Manual approval and subscription adjustments are available to the owner.
- **Optional Telegram SOCKS proxy**, PostgreSQL persistence, graceful shutdown and PM2/backup/health-check scripts.

**Payment integration scope:** the database models also include YooKassa and Robokassa. Their API processing is **not implemented**; the current non-Stars flow only prepares a payment record for later integration. Stars prices must be configured before invoices can be issued.

### Lead processing overview

```text
Telegram source chat
       |
       v
Message filtering (blocked sources/users and blacklisted phrases)
       |
       +--> Owner's weighted web-development detector --> OWNER lead
       |
       +--> Subscribers' personal phrase matching -----> USER:<id> leads
                                                             |
                                                             v
                                               PostgreSQL + Telegram delivery
```

The detection algorithm is implemented in [`src/lead-detector.ts`](src/lead-detector.ts). It does not guarantee that every matched message is a genuine sales enquiry; false positives and missed leads are possible.

## Technology

| Layer | Technologies |
| --- | --- |
| Runtime | Node.js 22, TypeScript, ES modules |
| Telegram API | grammY, long polling, optional `socks-proxy-agent` |
| Data | PostgreSQL, Prisma ORM 7.10, `@prisma/adapter-pg` |
| Build | esbuild, tsx, TypeScript compiler |
| Operations | GitHub Actions, Bash, PM2 configuration |

The project currently keeps most Telegram handlers and application workflows in [`src/index.ts`](src/index.ts); this is an implementation snapshot, not a claim of a fully modular production architecture.

## Repository structure

```text
src/
  index.ts                 Telegram handlers, lead workflow, subscriptions and payments
  lead-detector.ts         Weighted rule-based classifier
prisma/
  schema.prisma            PostgreSQL models, relations and indexes
prisma.config.ts           Prisma CLI configuration
scripts/
  backup-db.sh             PostgreSQL backup script
  healthcheck.sh           Operational checks
  deploy.sh                Production-oriented deployment script (see warning below)
  close-active-leads.ts    Administrative maintenance utility
.github/workflows/ci.yml   Install and validation workflow
.env.example               Non-secret configuration template
```

## Local development

**Prerequisites:** Node.js 22, npm, an isolated PostgreSQL database and a separate development bot token from [BotFather](https://t.me/BotFather). Configure Telegram group permissions/privacy mode so the bot can receive the intended source messages.

```bash
git clone https://github.com/RILFOK/tg-hot-leads-bot.git
cd tg-hot-leads-bot

npm ci
cp .env.example .env
# Edit .env: use DEVELOPMENT credentials and a disposable DATABASE_URL.

npm run db:generate
npm run db:push       # LOCAL / DISPOSABLE DATABASE ONLY
npm run dev           # Starts Telegram polling
```

Do not run development and production instances simultaneously with the same bot token. `db:push` changes the target database schema and is **not** a substitute for a reviewed production migration strategy.

### Configuration

The full non-secret template is in [`.env.example`](.env.example).

| Variable | Purpose |
| --- | --- |
| `BOT_TOKEN` | Required. Telegram bot token |
| `OWNER_TELEGRAM_ID` | Required. Owner's numeric Telegram user ID |
| `ADMIN_CHAT_ID` | Required. Lead/administration destination chat ID |
| `DATABASE_URL` | Required. PostgreSQL connection string |
| `TELEGRAM_PROXY_URL` | Optional. SOCKS proxy URL |
| `MIN_LEAD_SCORE` | Global detector threshold (default: `3`) |
| `HOT_LEAD_MINUTES` | Hot-lead timing window (default: `30`) |
| `SPAM_WINDOW_MINUTES`, `SPAM_MAX_TRIGGERS` | Repeated-trigger guard (defaults: `15`, `10`) |
| `TRIAL_DAYS` | Trial duration (default: `7`) |
| `START_PRICE_STARS`, `PRO_PRICE_STARS` | Optional prices for Telegram Stars invoices |
| `START_PRICE_RUB`, `PRO_PRICE_RUB` | Optional RUB offer amounts; external provider API flow is not yet implemented |
| `PAYMENT_DURATION_DAYS`, `PAYMENT_ORDER_TTL_MINUTES` | Optional paid-period and order-expiry settings (defaults: `30`, `30`) |

For reference, the current plan limits defined in code are:

| Plan | Personal triggers | Source chats |
| --- | ---: | ---: |
| Trial | 5 | 2 |
| Start | 20 | 5 |
| Pro | 100 | 20 |
| Manual | 20 | 5 |
| Owner | Unlimited | Unlimited |

Plan prices are environment-dependent, not hard-coded in the repository.

## Validation

With a configured `DATABASE_URL` (a disposable URL is sufficient for client generation and static checks):

```bash
npx prisma validate
npm run check
npm audit
```

`npm run check` generates the Prisma client, type-checks the source, builds the application, validates the generated JavaScript syntax and audits production dependencies. GitHub Actions runs this check for pushes to `main` and pull requests.

**Coverage limitation:** these checks do not execute Telegram end-to-end interactions, a real payment or PostgreSQL integration tests. In particular, the lockfile currently includes security overrides for transitive packages; Prisma schema validation and generation have been checked, but database integration should be exercised in an isolated environment before deployment.

Other available commands: `npm run build`, `npm run typecheck`, `npm run db:studio`, `npm run backup`, `npm run health`.

## Data handling and deployment safety

The application persists message text and lead metadata, Telegram identifiers and selected payment-event data in PostgreSQL. Use authorized source chats, restrict database/log/backup access, and establish an appropriate data-retention policy. Never commit actual `.env` files, user exports, database dumps, live tokens or payment credentials.

**Do not run `npm run deploy` as a local setup step.** The existing [deployment script](scripts/deploy.sh) fetches `main`, installs dependencies, runs checks, creates a database backup, executes `prisma db push` and starts/reloads PM2. Review its database target, schema-change impact and rollback procedure independently before any production use.

## Development priorities

- Integration tests using a disposable PostgreSQL database, especially for tenant isolation and payment idempotency.
- A reviewed migration and rollback process for production databases.
- Actual external payment-provider integrations (YooKassa / Robokassa), if required.
- Continued decomposition of the large application entry point.

**Contact:** [@rilfok](https://t.me/rilfok).
