# Telegram Hot Leads Bot

[![CI](https://github.com/RILFOK/tg-hot-leads-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/RILFOK/tg-hot-leads-bot/actions/workflows/ci.yml)
![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7.10-2D3748?logo=prisma&logoColor=white)

**Язык / Language:** [Русский](#русский) · [English](#english)

## Русский

**Telegram-бот для мониторинга потенциальных заявок** на веб-разработку в подключённых чатах. Находит релевантные сообщения и отправляет заявки владельцу или отдельным подписчикам. Использует понятные правила и взвешенные текстовые сигналы, а не внешний AI-сервис.

> **Статус:** исходный код опубликован для портфолио; разработка продолжается. Репозиторий не является публичной демонстрацией работающего бота или готовым решением для развёртывания в production.

### Возможности

- **Поиск заявок по правилам:** положительные и отрицательные сигналы в русскоязычном тексте, настраиваемый порог срабатывания (0–10), категории сайтов, лендингов, интернет-магазинов и доработок.
- **Разделение заявок:** глобальный детектор владельца и персональные фразы-триггеры подписчиков создают независимые записи заявок и состояния доставки.
- **Источники и триггеры:** подключение и отключение чатов, управление фразами, ограничения по тарифам и отправка подходящих сообщений в настроенный чат уведомлений.
- **Работа с заявками:** защита от дублей и повторных срабатываний, антиспам, учёт времени горячих заявок, изменение статусов, заметки, архив, корзина и восстановление.
- **Панель владельца:** управление пользователями и подписками, статистика, заблокированные пользователи и чаты-источники, чёрный список фраз.
- **Подписки и платежи:** пробный доступ, тарифы Start и Pro, режим владельца; выставление счетов через Telegram Stars с проверкой перед оплатой, защитой от повторной обработки платёжных событий и транзакционной активацией подписки. Владелец также может вручную подтверждать платежи и корректировать подписки.
- **Инфраструктура:** необязательный Telegram SOCKS-прокси, хранение данных в PostgreSQL, корректное завершение процесса, скрипты для PM2, резервного копирования и проверки состояния.

**Статус платёжных интеграций:** схема базы данных предусматривает YooKassa и Robokassa, но обработка платежей через их API **ещё не реализована**. Сейчас для способов, отличных от Stars, создаётся платёжная запись под будущую интеграцию. Для выставления счетов в Stars необходимо настроить цены.

#### Схема обработки заявок

```text
Исходный Telegram-чат
         |
         v
Фильтрация сообщений (заблокированные чаты/пользователи, чёрные слова)
         |
         +--> Взвешенный детектор владельца --> Заявка OWNER
         |
         +--> Персональные фразы подписчиков --> Заявки USER:<id>
                                                        |
                                                        v
                                         PostgreSQL + уведомления в Telegram
```

Алгоритм поиска находится в [`src/lead-detector.ts`](src/lead-detector.ts). Совпадение с правилами не гарантирует, что сообщение является реальным коммерческим запросом: возможны ложные срабатывания и пропущенные заявки.

### Технологический стек

| Компонент | Технологии |
| --- | --- |
| Среда выполнения | Node.js 22, TypeScript, ES modules |
| Telegram API | grammY, long polling, необязательный `socks-proxy-agent` |
| Данные | PostgreSQL, Prisma ORM 7.10, `@prisma/adapter-pg` |
| Сборка | esbuild, tsx, компилятор TypeScript |
| Эксплуатация | GitHub Actions, Bash, конфигурация PM2 |

Сейчас большая часть обработчиков Telegram и прикладных сценариев находится в [`src/index.ts`](src/index.ts). Это описание текущей реализации, а не заявление о полностью модульной production-архитектуре.

### Структура репозитория

```text
src/
  index.ts                 Обработчики Telegram, заявки, подписки и платежи
  lead-detector.ts         Взвешенный детектор на основе текстовых правил
prisma/
  schema.prisma            Модели PostgreSQL, связи и индексы
prisma.config.ts           Конфигурация Prisma CLI
scripts/
  backup-db.sh             Резервное копирование PostgreSQL
  healthcheck.sh           Эксплуатационные проверки
  deploy.sh                Скрипт развёртывания (см. предупреждение ниже)
  close-active-leads.ts    Административная утилита
.github/workflows/ci.yml   Установка зависимостей и проверки CI
.env.example               Шаблон настроек без реальных секретов
```

### Локальная разработка

**Требования:** Node.js 22, npm, изолированная база PostgreSQL и отдельный тестовый токен бота от [BotFather](https://t.me/BotFather). Настройте разрешения и режим конфиденциальности Telegram-групп так, чтобы бот получал необходимые сообщения из выбранных источников.

```bash
git clone https://github.com/RILFOK/tg-hot-leads-bot.git
cd tg-hot-leads-bot

npm ci
cp .env.example .env
# Заполните .env: только тестовые учётные данные и отдельный DATABASE_URL.

npm run db:generate
npm run db:push       # ТОЛЬКО ЛОКАЛЬНАЯ / ОДНОРАЗОВАЯ БД
npm run dev           # Запускает Telegram long polling
```

Не запускайте тестовую и рабочую версии одновременно с одним токеном бота. Команда `db:push` изменяет схему указанной БД и **не заменяет** согласованную стратегию production-миграций.

#### Конфигурация

Полный шаблон без рабочих секретов — в [`.env.example`](.env.example).

| Переменная | Назначение |
| --- | --- |
| `BOT_TOKEN` | Обязательная. Токен Telegram-бота |
| `OWNER_TELEGRAM_ID` | Обязательная. Числовой Telegram ID владельца |
| `ADMIN_CHAT_ID` | Обязательная. ID чата для заявок и администрирования |
| `DATABASE_URL` | Обязательная. Строка подключения к PostgreSQL |
| `TELEGRAM_PROXY_URL` | Необязательная. Адрес SOCKS-прокси |
| `MIN_LEAD_SCORE` | Порог глобального детектора (по умолчанию: `3`) |
| `HOT_LEAD_MINUTES` | Временное окно горячей заявки (по умолчанию: `30`) |
| `SPAM_WINDOW_MINUTES`, `SPAM_MAX_TRIGGERS` | Ограничение повторных срабатываний (по умолчанию: `15` и `10`) |
| `TRIAL_DAYS` | Продолжительность пробного периода (по умолчанию: `7`) |
| `START_PRICE_STARS`, `PRO_PRICE_STARS` | Необязательные цены счетов Telegram Stars |
| `START_PRICE_RUB`, `PRO_PRICE_RUB` | Необязательные суммы предложений в рублях; API внешних провайдеров пока не подключён |
| `PAYMENT_DURATION_DAYS`, `PAYMENT_ORDER_TTL_MINUTES` | Необязательные срок платного доступа и время жизни заказа (по умолчанию: `30` и `30`) |

Текущие ограничения тарифов, заданные в коде:

| Тариф | Персональные триггеры | Чаты-источники |
| --- | ---: | ---: |
| Trial | 5 | 2 |
| Start | 20 | 5 |
| Pro | 100 | 20 |
| Manual | 20 | 5 |
| Owner | Без ограничений | Без ограничений |

Цены задаются переменными окружения, а не жёстко прописаны в репозитории.

### Проверка проекта

Укажите `DATABASE_URL` (для генерации клиента и статических проверок достаточно строки подключения к одноразовой БД):

```bash
npx prisma validate
npm run check
npm audit
```

Команда `npm run check` генерирует Prisma Client, проверяет типы, собирает приложение, проверяет синтаксис итогового JavaScript и выполняет аудит production-зависимостей. GitHub Actions запускает эту проверку для Pull Requests и обновлений `main`.

**Ограничение проверки:** эти команды не проводят сквозное тестирование Telegram, реальные платежи или интеграционные тесты PostgreSQL. В lock-файле используются точечные `overrides` для транзитивных зависимостей. Валидация схемы Prisma и генерация клиента проверены, но перед развёртыванием необходимо дополнительно проверить работу с отдельной тестовой БД.

Другие команды: `npm run build`, `npm run typecheck`, `npm run db:studio`, `npm run backup`, `npm run health`.

### Обработка данных и безопасность развёртывания

Приложение сохраняет в PostgreSQL текст сообщений, метаданные заявок, Telegram-идентификаторы и часть данных платёжных событий. Используйте только разрешённые чаты-источники, ограничивайте доступ к БД, логам и резервным копиям, установите подходящую политику хранения данных. Никогда не публикуйте реальные `.env`, выгрузки пользователей, дампы БД, действующие токены и платёжные секреты.

**Не используйте `npm run deploy` для локального запуска.** Существующий [скрипт развёртывания](scripts/deploy.sh) получает обновления `main`, устанавливает зависимости, запускает проверки, создаёт резервную копию БД, выполняет `prisma db push` и запускает или перезагружает PM2. Перед применением в production отдельно проверьте целевую базу, последствия изменения схемы и процедуру отката.

### Дальнейшие задачи

- Интеграционные тесты с одноразовой PostgreSQL, прежде всего для изоляции пользователей и идемпотентности платежей.
- Проверенный порядок миграции production-БД и отката изменений.
- Подключение API внешних платёжных провайдеров (YooKassa / Robokassa), если потребуется.
- Постепенное разделение крупного входного файла приложения на самостоятельные модули.

**Контакт:** [@rilfok](https://t.me/rilfok).

---

## English

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
