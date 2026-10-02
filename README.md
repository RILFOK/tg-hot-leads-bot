# Telegram Hot Leads Bot

A Telegram bot for collecting and classifying potential web-development enquiries from configured source chats. Portfolio-oriented documentation of an actively developed private project.

## Stack
Node.js 22 · TypeScript · grammY · PostgreSQL · Prisma · esbuild.

## Main components
- Rule-based lead detector with weighted positive/negative text signals and lead categories.
- Lead deduplication, status tracking and configurable trigger thresholds.
- Owner and user roles, source-chat settings and notification delivery.
- Subscription plans and payment-domain models.
- PostgreSQL data model and TypeScript application logic.

Key source files: [entry point](src/index.ts), [lead detector](src/lead-detector.ts), [Prisma schema](prisma/schema.prisma).

## Development setup
Requires Node.js 22, npm and PostgreSQL.

```bash
npm ci
cp .env.example .env
# Set BOT_TOKEN, ADMIN_CHAT_ID, OWNER_TELEGRAM_ID and DATABASE_URL
npm run db:generate
npm run db:push
npm run typecheck
npm run dev
```

Build/check commands:

```bash
npm run build
npm run check
```

The `db:push` command is intended for local development; validate your migration/deployment approach before using a production database.

## Configuration and safety
Use separate Telegram bot credentials and a disposable database for testing. Never commit real `.env` files, chat exports, payment credentials or customer data. `.env.example` is a template only.

Status: in development. Features should be verified against the current branch before production use.
