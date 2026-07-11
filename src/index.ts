import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { SocksProxyAgent } from "socks-proxy-agent";
import {
  LeadCategory,
  LeadDeliveryType,
  LeadStatus,
  PaymentProvider,
  PaymentStatus,
  PrismaClient,
  SubscriptionStatus,
  UserRole
} from "../generated/prisma/client";
import { detectLead, type LeadDetectionResult } from "./lead-detector";

const token = process.env.BOT_TOKEN?.trim();
const adminChatId = process.env.ADMIN_CHAT_ID?.trim();
const ownerTelegramId = process.env.OWNER_TELEGRAM_ID?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();
const telegramProxyUrl =
  process.env.TELEGRAM_PROXY_URL?.trim();

function readOptionalPositiveIntegerEnv(
  name: string
): number | null {
  const rawValue =
    process.env[name]?.trim();

  if (!rawValue) {
    return null;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(
      `${name} должен быть положительным целым числом`
    );
  }

  const value = Number(rawValue);

  if (
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(
      `${name} должен быть положительным целым числом`
    );
  }

  return value;
}

function rublesToMinorUnits(
  envName: string,
  rubles: number | null
): number | null {
  if (rubles === null) {
    return null;
  }

  const amountMinor =
    rubles * 100;

  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error(
      `${envName} содержит слишком большое значение`
    );
  }

  return amountMinor;
}

const minLeadScore = Number(process.env.MIN_LEAD_SCORE ?? 3);
const hotLeadMinutes = Number(process.env.HOT_LEAD_MINUTES ?? 30);
const spamWindowMinutes = Number(process.env.SPAM_WINDOW_MINUTES ?? 15);
const spamMaxTriggers = Number(process.env.SPAM_MAX_TRIGGERS ?? 10);
const trialDays = Number(process.env.TRIAL_DAYS ?? 7);

const paymentDurationDays =
  readOptionalPositiveIntegerEnv(
    "PAYMENT_DURATION_DAYS"
  ) ?? 30;

const paymentOrderTtlMinutes =
  readOptionalPositiveIntegerEnv(
    "PAYMENT_ORDER_TTL_MINUTES"
  ) ?? 30;

const paymentOrderTtlMs =
  paymentOrderTtlMinutes * 60 * 1000;

const startPriceStars =
  readOptionalPositiveIntegerEnv(
    "START_PRICE_STARS"
  );

const proPriceStars =
  readOptionalPositiveIntegerEnv(
    "PRO_PRICE_STARS"
  );

const startPriceRubMinor =
  rublesToMinorUnits(
    "START_PRICE_RUB",
    readOptionalPositiveIntegerEnv(
      "START_PRICE_RUB"
    )
  );

const proPriceRubMinor =
  rublesToMinorUnits(
    "PRO_PRICE_RUB",
    readOptionalPositiveIntegerEnv(
      "PRO_PRICE_RUB"
    )
  );

const hotLeadMs = hotLeadMinutes * 60 * 1000;
const spamWindowMs = spamWindowMinutes * 60 * 1000;

if (!token) throw new Error("BOT_TOKEN не задан. Заполни .env");
if (!adminChatId) throw new Error("ADMIN_CHAT_ID не задан. Заполни .env");
if (!ownerTelegramId) {
  throw new Error("OWNER_TELEGRAM_ID не задан. Заполни .env");
}
if (!/^\d+$/.test(ownerTelegramId)) {
  throw new Error("OWNER_TELEGRAM_ID должен содержать только цифры");
}
if (!databaseUrl) throw new Error("DATABASE_URL не задан. Заполни .env");

const adminTargetChatId: string = adminChatId;
const ownerTelegramUserId: string = ownerTelegramId;

if (!Number.isFinite(minLeadScore)) {
  throw new Error("MIN_LEAD_SCORE должен быть числом");
}

if (!Number.isFinite(hotLeadMinutes) || hotLeadMinutes <= 0) {
  throw new Error("HOT_LEAD_MINUTES должен быть положительным числом");
}

if (!Number.isFinite(spamWindowMinutes) || spamWindowMinutes <= 0) {
  throw new Error("SPAM_WINDOW_MINUTES должен быть положительным числом");
}

if (!Number.isInteger(spamMaxTriggers) || spamMaxTriggers <= 0) {
  throw new Error("SPAM_MAX_TRIGGERS должен быть положительным целым числом");
}

if (!Number.isInteger(trialDays) || trialDays <= 0) {
  throw new Error("TRIAL_DAYS должен быть положительным целым числом");
}

if (
  !Number.isInteger(paymentDurationDays) ||
  paymentDurationDays <= 0 ||
  paymentDurationDays > 3650
) {
  throw new Error(
    "PAYMENT_DURATION_DAYS должен быть целым числом от 1 до 3650"
  );
}

if (
  !Number.isInteger(paymentOrderTtlMinutes) ||
  paymentOrderTtlMinutes < 5 ||
  paymentOrderTtlMinutes > 1440
) {
  throw new Error(
    "PAYMENT_ORDER_TTL_MINUTES должен быть целым числом от 5 до 1440"
  );
}

type PlanCode =
  | "OWNER"
  | "TRIAL"
  | "START"
  | "PRO"
  | "MANUAL";

type PlanDefinition = {
  code: PlanCode;
  label: string;
  maxTriggers: number | null;
  maxSources: number | null;
};

const PLAN_DEFINITIONS: Record<
  PlanCode,
  PlanDefinition
> = {
  OWNER: {
    code: "OWNER",
    label: "Владелец",
    maxTriggers: null,
    maxSources: null
  },
  TRIAL: {
    code: "TRIAL",
    label: "Пробный",
    maxTriggers: 5,
    maxSources: 2
  },
  START: {
    code: "START",
    label: "Start",
    maxTriggers: 20,
    maxSources: 5
  },
  PRO: {
    code: "PRO",
    label: "Pro",
    maxTriggers: 100,
    maxSources: 20
  },
  MANUAL: {
    code: "MANUAL",
    label: "Ручная подписка",
    maxTriggers: 20,
    maxSources: 5
  }
};

type PaymentOffer = {
  planCode: PaidPlanCode;
  durationDays: number;
  starsAmount: number | null;
  rubAmountMinor: number | null;
};

const PAYMENT_OFFERS: Record<
  PaidPlanCode,
  PaymentOffer
> = {
  START: {
    planCode: "START",
    durationDays: paymentDurationDays,
    starsAmount: startPriceStars,
    rubAmountMinor: startPriceRubMinor
  },
  PRO: {
    planCode: "PRO",
    durationDays: paymentDurationDays,
    starsAmount: proPriceStars,
    rubAmountMinor: proPriceRubMinor
  }
};

function resolvePlanCode(user: {
  role: UserRole;
  subscription: {
    planCode?: string | null;
  } | null;
}): PlanCode {
  if (user.role === UserRole.OWNER) {
    return "OWNER";
  }

  const rawPlanCode =
    user.subscription?.planCode
      ?.trim()
      .toUpperCase();

  if (!rawPlanCode) {
    return "TRIAL";
  }

  if (
    Object.prototype.hasOwnProperty.call(
      PLAN_DEFINITIONS,
      rawPlanCode
    )
  ) {
    return rawPlanCode as PlanCode;
  }

  // Неизвестный вручную созданный тариф получает
  // безопасные лимиты MANUAL, а не пробные лимиты.
  return "MANUAL";
}

function getPlanDefinition(user: {
  role: UserRole;
  subscription: {
    planCode?: string | null;
  } | null;
}): PlanDefinition {
  return PLAN_DEFINITIONS[resolvePlanCode(user)];
}

function formatPlanLimit(
  limit: number | null
): string {
  return limit === null
    ? "без ограничений"
    : String(limit);
}

function formatPlanUsage(
  current: number,
  limit: number | null
): string {
  return limit === null
    ? `${current} / без ограничений`
    : `${current} / ${limit}`;
}

function formatRubPrice(
  amountMinor: number | null
): string {
  if (amountMinor === null) {
    return "не настроена";
  }

  return `${new Intl.NumberFormat(
    "ru-RU",
    {
      maximumFractionDigits: 2
    }
  ).format(amountMinor / 100)} ₽`;
}

function formatStarsPrice(
  amount: number | null
): string {
  if (amount === null) {
    return "не настроена";
  }

  return `${new Intl.NumberFormat(
    "ru-RU"
  ).format(amount)} Stars`;
}

function formatPaymentOfferPrices(
  offer: PaymentOffer
): string {
  const prices: string[] = [];

  if (offer.starsAmount !== null) {
    prices.push(
      formatStarsPrice(
        offer.starsAmount
      )
    );
  }

  if (offer.rubAmountMinor !== null) {
    prices.push(
      formatRubPrice(
        offer.rubAmountMinor
      )
    );
  }

  return prices.length > 0
    ? prices.join(" / ")
    : "цена не настроена";
}

function getPaymentProviderLabel(
  provider: PaymentProvider
): string {
  switch (provider) {
    case PaymentProvider.TELEGRAM_STARS:
      return "Telegram Stars";
    case PaymentProvider.YOOKASSA:
      return "ЮKassa";
    case PaymentProvider.ROBOKASSA:
      return "Robokassa";
  }
}

function getConfiguredPaymentAmount(
  provider: PaymentProvider,
  offer: PaymentOffer
): {
  amountMinor: number;
  currency: "XTR" | "RUB";
} | null {
  if (
    provider ===
    PaymentProvider.TELEGRAM_STARS
  ) {
    if (offer.starsAmount === null) {
      return null;
    }

    return {
      amountMinor: offer.starsAmount,
      currency: "XTR"
    };
  }

  if (offer.rubAmountMinor === null) {
    return null;
  }

  return {
    amountMinor: offer.rubAmountMinor,
    currency: "RUB"
  };
}

const adapter = new PrismaPg({
  connectionString: databaseUrl
});

const prisma = new PrismaClient({
  adapter
});

const telegramProxyAgent =
  telegramProxyUrl
    ? new SocksProxyAgent(
        telegramProxyUrl
      )
    : null;

const bot = new Bot(
  token,
  telegramProxyAgent
    ? {
        client: {
          baseFetchConfig: {
            agent:
              telegramProxyAgent,
            compress: true
          }
        }
      }
    : undefined
);

console.log(
  "TELEGRAM_PROXY",
  telegramProxyAgent
    ? "enabled"
    : "disabled"
);

const seenMessages = new Map<string, number>();
const scheduledHotRefreshes = new Map<string, NodeJS.Timeout>();

const leadNotificationSelect = {
  id: true,
  sourceChatId: true,
  sourceChatTitle: true,
  sourceMessageId: true,
  messageText: true,
  matchedKeywords: true,
  negativeKeywords: true,
  score: true,
  category: true,
  authorTelegramId: true,
  authorUsername: true,
  authorName: true,
  messageUrl: true,
  note: true,
  adminChatId: true,
  adminMessageId: true,
  triggerCount: true,
  lastTriggeredAt: true,
  status: true,
  createdAt: true,
  updatedAt: true
} as const;

type LeadNotificationData = {
  id: string;
  sourceChatId: string;
  sourceChatTitle: string;
  sourceMessageId: number;
  messageText: string;
  matchedKeywords: string[];
  negativeKeywords: string[];
  score: number;
  category: LeadCategory;
  authorTelegramId: string | null;
  authorUsername: string | null;
  authorName: string | null;
  messageUrl: string | null;
  note: string | null;
  adminChatId: string | null;
  adminMessageId: number | null;
  triggerCount: number;
  lastTriggeredAt: Date;
  status: LeadStatus;
  createdAt: Date;
  updatedAt: Date;
};

type DisplayStatus = {
  label: string;
  emoji: string;
};

type UserTriggerData = {
  id: string;
  phrase: string;
  normalizedPhrase: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type PersonalTriggerRecipient = {
  userId: string;
  telegramId: string;
  deliveryChatId: string;
  matchedTriggers: string[];
};

type PersonalLeadDeliveryData = {
  id: string;
  leadId: string;
  recipientUserId: string | null;
  recipientChatId: string;
  deliveryType: LeadDeliveryType;
  matchedTriggers: string[];
  telegramMessageId: number | null;
  status: LeadStatus;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  lead: LeadNotificationData;
};

const personalLeadDeliverySelect = {
  id: true,
  leadId: true,
  recipientUserId: true,
  recipientChatId: true,
  deliveryType: true,
  matchedTriggers: true,
  telegramMessageId: true,
  status: true,
  note: true,
  createdAt: true,
  updatedAt: true,
  lead: {
    select: leadNotificationSelect
  }
} as const;

const pipelineLeadStatuses = new Set<LeadStatus>([
  LeadStatus.CONTACTED,
  LeadStatus.WAITING_REPLY,
  LeadStatus.IN_PROGRESS
]);

const restorableLeadStatuses = new Set<LeadStatus>([
  LeadStatus.IGNORED,
  LeadStatus.DELETED
]);

type LeadHandleResult =
  | {
      action: "send";
      lead: LeadNotificationData;
    }
  | {
      action: "update";
      lead: LeadNotificationData;
    }
  | {
      action: "skip";
      lead: null;
    };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizePlain(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}.+#\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupSeenMessages(): void {
  const now = Date.now();
  const ttl = 1000 * 60 * 60 * 24;

  for (const [key, createdAt] of seenMessages.entries()) {
    if (now - createdAt > ttl) {
      seenMessages.delete(key);
    }
  }
}

function getMessageKey(ctx: Context): string {
  return `${ctx.chat?.id ?? "unknown"}:${ctx.message?.message_id ?? "unknown"}`;
}

function getChatTitle(ctx: Context): string {
  const chat = ctx.chat;
  if (!chat) return "Неизвестный чат";
  if ("title" in chat && chat.title) return chat.title;
  if ("username" in chat && chat.username) return `@${chat.username}`;
  return String(chat.id);
}

function getAuthorName(ctx: Context): string | null {
  const from = ctx.from;
  if (!from) return null;

  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

function getAuthorUsername(ctx: Context): string | null {
  return ctx.from?.username ?? null;
}

function getAuthorLine(ctx: Context): string {
  const from = ctx.from;
  if (!from) return "Неизвестный автор";

  const name = getAuthorName(ctx) ?? "Без имени";
  const username = from.username ? `@${from.username}` : "username скрыт";

  return `${name} / ${username} / id: ${from.id}`;
}

function getMessageUrl(ctx: Context): string | null {
  const chat = ctx.chat;
  const messageId = ctx.message?.message_id;

  if (!chat || !messageId) return null;

  if ("username" in chat && chat.username) {
    return `https://t.me/${chat.username}/${messageId}`;
  }

  if (chat.type === "supergroup") {
    const rawId = String(chat.id);
    if (rawId.startsWith("-100")) {
      return `https://t.me/c/${rawId.slice(4)}/${messageId}`;
    }
  }

  return null;
}

function getShortLeadId(leadId: string): string {
  return leadId.slice(-8);
}

function normalizePurpose(value: string): string | null {
  let result = value
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[«»"']/g, "")
    .replace(/\s+/g, " ")
    .trim();

  result = result
    .split(/\b(?:срочно|бюджет|цена|стоимость|оплата|подскажите|посоветуйте|кто|где|может|нужно|надо)\b/i)[0]
    .trim();

  result = result
    .replace(/^(?:своего|моего|нашего|вашего|собственного)\s+/i, "")
    .replace(/^(?:для|под)\s+/i, "")
    .replace(/[.,!?;:]+$/g, "")
    .trim();

  if (!result || result.length < 3) return null;

  const useless = new Set(["сайт", "лендинг", "интернет магазин", "интернет-магазин", "страница"]);
  if (useless.has(result)) return null;

  return result.slice(0, 70);
}

function getCategoryBaseTitle(category: LeadDetectionResult["category"] | LeadCategory): string {
  const key = String(category).toLowerCase();

  switch (key) {
    case "landing":
      return "Лендинг";
    case "shop":
      return "Интернет-магазин";
    case "support":
      return "Доработка сайта";
    case "unknown":
      return "Разработчик / уточнить задачу";
    case "site":
    default:
      return "Сайт";
  }
}

function inferLeadType(
  text: string,
  category: LeadDetectionResult["category"] | LeadCategory
): string {
  const baseTitle = getCategoryBaseTitle(category);

  const patterns = [
    /(?:сайт|лендинг|интернет[-\s]?магазин|страниц[ау])\s+(?:для|под)\s+([^.!?\n,;]+)/i,
    /(?:хочу|нужен|нужна|надо|нужно|ищу|сделать|создать|разработать)\s+(?:сайт|лендинг|интернет[-\s]?магазин|страниц[ау])\s+(?:для|под)\s+([^.!?\n,;]+)/i,
    /(?:для|под)\s+([^.!?\n,;]+)\s+(?:сайт|лендинг|интернет[-\s]?магазин|страниц[ау])/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const purpose = match?.[1] ? normalizePurpose(match[1]) : null;

    if (purpose) {
      return `${baseTitle} для ${purpose}`;
    }
  }

  return baseTitle;
}

function getDisplayStatus(
  lead: Pick<LeadNotificationData, "status" | "createdAt" | "lastTriggeredAt">
): DisplayStatus {
  switch (lead.status) {
    case LeadStatus.CONTACTED:
      return { label: "Обработана", emoji: "✅" };
    case LeadStatus.WAITING_REPLY:
      return { label: "Ждём ответ", emoji: "⏳" };
    case LeadStatus.IN_PROGRESS:
      return { label: "В обсуждении", emoji: "💬" };
    case LeadStatus.WON:
      return { label: "В работе", emoji: "🏆" };
    case LeadStatus.LOST:
      return { label: "Отказ / не актуально", emoji: "❌" };
    case LeadStatus.IGNORED:
      return { label: "Архив", emoji: "🗄" };
    case LeadStatus.DELETED:
      return { label: "Удалено", emoji: "🗑" };
    case LeadStatus.NEW:
    default: {
      const hotSince = lead.lastTriggeredAt ?? lead.createdAt;
      const isHot = Date.now() - hotSince.getTime() < hotLeadMs;
      return isHot ? { label: "Горячий", emoji: "🔥" } : { label: "Новая", emoji: "🆕" };
    }
  }
}

function formatBulletList(items: string[]): string {
  if (!items.length) return "—";
  return items.map((item) => `• ${escapeHtml(item)}`).join("\n");
}

function formatLeadNotification(lead: LeadNotificationData): string {
  const gap = "\u200B";
  const status = getDisplayStatus(lead);
  const leadType = inferLeadType(lead.messageText, lead.category);

  const authorName = lead.authorName ?? "Без имени";
  const authorTelegram = lead.authorUsername ? `@${lead.authorUsername}` : "username скрыт";
  const authorId = lead.authorTelegramId ?? "неизвестен";
  const authorProfileUrl = lead.authorUsername ? `https://t.me/${lead.authorUsername}` : null;

  const displayScore = Math.max(0, Math.min(10, lead.score));

  const safeText =
    lead.messageText.length > 1000
      ? `${lead.messageText.slice(0, 1000)}...`
      : lead.messageText;

  const clientTitle = authorProfileUrl
    ? `<a href="${escapeHtml(authorProfileUrl)}">${escapeHtml(authorName)}</a>`
    : escapeHtml(authorName);

  const sourceTitle = lead.messageUrl
    ? `<a href="${escapeHtml(lead.messageUrl)}">${escapeHtml(lead.sourceChatTitle)}</a>`
    : escapeHtml(lead.sourceChatTitle);

  return [
    "🔥 <b>Горячий клиент</b>",
    gap,

    `📌 <b>Тип:</b> ${escapeHtml(leadType)}`,
    `${status.emoji} <b>Статус:</b> ${escapeHtml(status.label)}`,
    `⭐ <b>Оценка:</b> ${displayScore}/10`,
    gap,

    `💬 <b>Запрос клиента</b> — «${escapeHtml(safeText)}»`,
    gap,

    `👤 <b>Клиент:</b> ${clientTitle} | ${escapeHtml(authorTelegram)} | ID: <code>${escapeHtml(authorId)}</code>`,
    gap,

    `📍 <b>Источник</b> — ${sourceTitle}`,
    gap,

    "🎯 <b>Почему сработало</b>",
    formatBulletList(lead.matchedKeywords),
    lead.negativeKeywords.length
      ? ["", "⚠️ <b>Минус-слова</b>", formatBulletList(lead.negativeKeywords)].join("\n")
      : null,
    lead.note ? ["", "📝 <b>Заметка</b>", escapeHtml(lead.note)].join("\n") : null,
    gap,

    "🧾 <b>Технически</b>",
    `Lead ID: <code>${escapeHtml(getShortLeadId(lead.id))}</code>`
  ]
    .filter(Boolean)
    .join("\n");
}

function buildLeadKeyboard(lead: LeadNotificationData): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard.text(`🔁 Сработок от клиента: ${lead.triggerCount}`, `counter:${lead.id}`).row();

  if (lead.messageUrl) {
    keyboard.url("Открыть сообщение", lead.messageUrl).row();
  }

  if (lead.authorUsername) {
    keyboard.url("Написать клиенту", `https://t.me/${lead.authorUsername}`).row();
  }

  if (lead.status === LeadStatus.NEW) {
    keyboard
      .text("Связался", `status:contacted:${lead.id}`)
      .text("Ждём ответ", `status:waiting:${lead.id}`)
      .row()
      .text("В работу", `status:won:${lead.id}`)
      .text("Игнор", `status:ignored:${lead.id}`);
  } else if (lead.status === LeadStatus.WON) {
    keyboard
      .text(
        "Обработано",
        `status:contacted:${lead.id}`
      )
      .text(
        "Ждём ответ",
        `status:waiting:${lead.id}`
      )
      .row()
      .text(
        "В обсуждении",
        `status:progress:${lead.id}`
      )
      .text(
        "Отказ",
        `status:lost:${lead.id}`
      )
      .row()
      .text(
        "Игнор",
        `status:ignored:${lead.id}`
      );
  } else if (pipelineLeadStatuses.has(lead.status)) {
    keyboard
      .text("Ждём ответ", `status:waiting:${lead.id}`)
      .text("В обсуждении", `status:progress:${lead.id}`)
      .row()
      .text("В работу", `status:won:${lead.id}`)
      .text("Отказ", `status:lost:${lead.id}`)
      .row()
      .text("Игнор", `status:ignored:${lead.id}`);
  } else if (restorableLeadStatuses.has(lead.status)) {
    keyboard.text("♻️ Восстановить", `restore:${lead.id}`);
  }

  return keyboard;
}

function getSendOptions(lead: LeadNotificationData) {
  return {
    reply_markup: buildLeadKeyboard(lead),
    parse_mode: "HTML" as const,
    link_preview_options: {
      is_disabled: true
    }
  };
}

function toDbCategory(category: LeadDetectionResult["category"]): LeadCategory {
  switch (category) {
    case "site":
      return LeadCategory.SITE;
    case "landing":
      return LeadCategory.LANDING;
    case "shop":
      return LeadCategory.SHOP;
    case "support":
      return LeadCategory.SUPPORT;
    default:
      return LeadCategory.UNKNOWN;
  }
}

function assertAdmin(ctx: Context): boolean {
  return (
    ctx.chat?.type === "private" &&
    String(ctx.chat.id) === adminTargetChatId &&
    String(ctx.from?.id) === ownerTelegramUserId
  );
}

function getTrialExpiresAt(): Date {
  return new Date(
    Date.now() + trialDays * 24 * 60 * 60 * 1000
  );
}

function formatAccessDate(value: Date | null): string {
  if (!value) return "без ограничения";

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(value);
}

async function ensureOwnerAccount(): Promise<void> {
  const owner = await prisma.botUser.upsert({
    where: {
      telegramId: ownerTelegramUserId
    },
    update: {
      username: "rilfok",
      role: UserRole.OWNER,
      isActive: true,
      deliveryChatId: adminTargetChatId
    },
    create: {
      telegramId: ownerTelegramUserId,
      username: "rilfok",
      role: UserRole.OWNER,
      isActive: true,
      deliveryChatId: adminTargetChatId
    },
    select: {
      id: true,
      telegramId: true,
      role: true
    }
  });

  await prisma.subscription.upsert({
    where: {
      userId: owner.id
    },
    update: {
      planCode: "OWNER",
      status: SubscriptionStatus.ACTIVE,
      expiresAt: null,
      autoRenew: false
    },
    create: {
      userId: owner.id,
      planCode: "OWNER",
      status: SubscriptionStatus.ACTIVE,
      expiresAt: null,
      autoRenew: false
    }
  });

  console.log("OWNER_ACCOUNT_READY", {
    telegramId: owner.telegramId,
    role: owner.role
  });
}

async function registerBotUser(ctx: Context) {
  const from = ctx.from;
  const chat = ctx.chat;

  if (!from || !chat || chat.type !== "private") {
    return null;
  }

  const telegramId = String(from.id);
  const isOwner = telegramId === ownerTelegramUserId;

  const user = await prisma.botUser.upsert({
    where: {
      telegramId
    },
    update: {
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      deliveryChatId: String(chat.id),
      role: isOwner ? UserRole.OWNER : UserRole.USER
    },
    create: {
      telegramId,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      deliveryChatId: String(chat.id),
      role: isOwner ? UserRole.OWNER : UserRole.USER,
      isActive: true
    },
    select: {
      id: true,
      telegramId: true,
      role: true,
      isActive: true,
      deliveryChatId: true
    }
  });

  if (isOwner) {
    const subscription = await prisma.subscription.upsert({
      where: {
        userId: user.id
      },
      update: {
        planCode: "OWNER",
        status: SubscriptionStatus.ACTIVE,
        expiresAt: null,
        autoRenew: false
      },
      create: {
        userId: user.id,
        planCode: "OWNER",
        status: SubscriptionStatus.ACTIVE,
        expiresAt: null,
        autoRenew: false
      }
    });

    return {
      user,
      subscription
    };
  }

  const existingSubscription =
    await prisma.subscription.findUnique({
      where: {
        userId: user.id
      }
    });

  const subscription =
    existingSubscription ??
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planCode: "TRIAL",
        status: SubscriptionStatus.TRIAL,
        expiresAt: getTrialExpiresAt(),
        autoRenew: false
      }
    });

  console.log("BOT_USER_REGISTERED", {
    telegramId: user.telegramId,
    role: user.role,
    planCode: subscription.planCode,
    subscriptionStatus: subscription.status
  });

  return {
    user,
    subscription
  };
}

async function getCurrentBotUser(ctx: Context) {
  if (
    !ctx.from ||
    !ctx.chat ||
    ctx.chat.type !== "private"
  ) {
    return null;
  }

  return prisma.botUser.findUnique({
    where: {
      telegramId: String(ctx.from.id)
    },
    select: {
      id: true,
      telegramId: true,
      username: true,
      firstName: true,
      lastName: true,
      role: true,
      isActive: true,
      deliveryChatId: true,
      subscription: {
        select: {
          planCode: true,
          status: true,
          startsAt: true,
          expiresAt: true,
          autoRenew: true
        }
      }
    }
  });
}

async function getUserTriggers(
  userId: string
): Promise<UserTriggerData[]> {
  return prisma.userTrigger.findMany({
    where: {
      userId
    },
    orderBy: [
      {
        isActive: "desc"
      },
      {
        createdAt: "asc"
      }
    ],
    select: {
      id: true,
      phrase: true,
      normalizedPhrase: true,
      isActive: true,
      createdAt: true,
      updatedAt: true
    }
  });
}

function buildUserMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎯 Мои триггеры", "triggers:list")
    .row()
    .text("➕ Добавить триггер", "triggers:add");
}

function buildInactiveSubscriptionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "💳 Моя подписка",
      "subscription:view"
    )
    .row()
    .text(
      "📋 Тарифы",
      "plans:view"
    );
}

function buildPlansKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "🚀 Выбрать Start",
      "payment:plan:START"
    )
    .row()
    .text(
      "💼 Выбрать Pro",
      "payment:plan:PRO"
    );
}

function buildPaymentProviderKeyboard(
  planCode: PaidPlanCode
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "⭐ Telegram Stars",
      `payment:provider:TELEGRAM_STARS:${planCode}`
    )
    .row()
    .text(
      "💳 ЮKassa — скоро",
      `payment:provider:YOOKASSA:${planCode}`
    )
    .row()
    .text(
      "💳 Robokassa — скоро",
      `payment:provider:ROBOKASSA:${planCode}`
    )
    .row()
    .text(
      "← Назад к тарифам",
      "plans:view"
    );
}

function getTriggerButtonLabel(
  trigger: UserTriggerData
): string {
  const status = trigger.isActive ? "✅" : "⏸";
  const maxLength = 28;

  const phrase =
    trigger.phrase.length > maxLength
      ? `${trigger.phrase.slice(0, maxLength)}…`
      : trigger.phrase;

  return `${status} ${phrase}`;
}

function buildUserTriggersKeyboard(
  triggers: UserTriggerData[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const trigger of triggers) {
    keyboard
      .text(
        getTriggerButtonLabel(trigger),
        `trigger:toggle:${trigger.id}`
      )
      .text(
        "🗑",
        `trigger:delete:${trigger.id}`
      )
      .row();
  }

  keyboard
    .text("➕ Добавить", "triggers:add")
    .text("🔄 Обновить", "triggers:list")
    .row();

  return keyboard;
}

function formatUserTriggers(
  triggers: UserTriggerData[]
): string {
  if (!triggers.length) {
    return [
      "🎯 <b>Мои триггеры</b>",
      "",
      "У вас пока нет персональных триггеров.",
      "",
      "Для добавления используйте:",
      "<code>/addtrigger нужная фраза</code>",
      "",
      "Пример:",
      "<code>/addtrigger нужен дизайнер</code>"
    ].join("\n");
  }

  const activeCount = triggers.filter(
    (trigger) => trigger.isActive
  ).length;

  const items = triggers.map((trigger, index) => {
    const status = trigger.isActive
      ? "✅ включён"
      : "⏸ отключён";

    return [
      `${index + 1}. <b>${escapeHtml(trigger.phrase)}</b>`,
      `Статус: ${status}`
    ].join("\n");
  });

  return [
    "🎯 <b>Мои триггеры</b>",
    "",
    `Всего: ${triggers.length}`,
    `Активных: ${activeCount}`,
    "",
    items.join("\n\n"),
    "",
    "Нажмите на триггер, чтобы включить или отключить его.",
    "Кнопка 🗑 удаляет триггер."
  ].join("\n");
}

async function replyWithUserTriggers(
  ctx: Context,
  userId: string
): Promise<void> {
  const triggers = await getUserTriggers(userId);

  await ctx.reply(
    formatUserTriggers(triggers),
    {
      parse_mode: "HTML",
      reply_markup: buildUserTriggersKeyboard(triggers),
      link_preview_options: {
        is_disabled: true
      }
    }
  );
}

async function editUserTriggersMessage(
  ctx: Context,
  userId: string
): Promise<void> {
  const triggers = await getUserTriggers(userId);

  await ctx.editMessageText(
    formatUserTriggers(triggers),
    {
      parse_mode: "HTML",
      reply_markup: buildUserTriggersKeyboard(triggers),
      link_preview_options: {
        is_disabled: true
      }
    }
  ).catch((error) => {
    const message = String(error);

    if (!message.includes("message is not modified")) {
      console.error("USER_TRIGGERS_EDIT_ERROR", {
        userId,
        error
      });
    }
  });
}

function hasSubscriptionAccess(user: {
  role: UserRole;
  isActive: boolean;
  subscription: {
    status: SubscriptionStatus;
    expiresAt: Date | null;
  } | null;
}): boolean {
  if (!user.isActive) return false;
  if (user.role === UserRole.OWNER) return true;
  if (!user.subscription) return false;

  const validStatus =
    user.subscription.status === SubscriptionStatus.ACTIVE ||
    user.subscription.status === SubscriptionStatus.TRIAL;

  if (!validStatus) return false;

  if (
    user.subscription.expiresAt &&
    user.subscription.expiresAt.getTime() <= Date.now()
  ) {
    return false;
  }

  return true;
}

type PlanLimitEnforcementResult = {
  disabledTriggerCount: number;
  disabledSourceCount: number;
};

async function enforceUserPlanLimits(
  userId: string,
  plan: PlanDefinition
): Promise<PlanLimitEnforcementResult> {
  let disabledTriggerCount = 0;
  let disabledSourceCount = 0;

  if (plan.maxTriggers !== null) {
    const activeTriggers =
      await prisma.userTrigger.findMany({
        where: {
          userId,
          isActive: true
        },
        orderBy: [
          {
            createdAt: "asc"
          },
          {
            id: "asc"
          }
        ],
        select: {
          id: true
        }
      });

    const overflowTriggerIds =
      activeTriggers
        .slice(plan.maxTriggers)
        .map((trigger) => trigger.id);

    if (overflowTriggerIds.length) {
      const result =
        await prisma.userTrigger.updateMany({
          where: {
            userId,
            id: {
              in: overflowTriggerIds
            }
          },
          data: {
            isActive: false
          }
        });

      disabledTriggerCount = result.count;
    }
  }

  if (plan.maxSources !== null) {
    const activeSources =
      await prisma.userSourceChat.findMany({
        where: {
          userId,
          isActive: true,
          sourceChat: {
            isBlocked: false
          }
        },
        orderBy: [
          {
            createdAt: "asc"
          },
          {
            id: "asc"
          }
        ],
        select: {
          id: true
        }
      });

    const overflowSourceIds =
      activeSources
        .slice(plan.maxSources)
        .map((source) => source.id);

    if (overflowSourceIds.length) {
      const result =
        await prisma.userSourceChat.updateMany({
          where: {
            userId,
            id: {
              in: overflowSourceIds
            }
          },
          data: {
            isActive: false
          }
        });

      disabledSourceCount = result.count;
    }
  }

  return {
    disabledTriggerCount,
    disabledSourceCount
  };
}

async function enforceAllUserPlanLimits(): Promise<void> {
  const users =
    await prisma.botUser.findMany({
      where: {
        role: UserRole.USER
      },
      select: {
        id: true,
        telegramId: true,
        role: true,
        subscription: {
          select: {
            planCode: true
          }
        }
      }
    });

  for (const user of users) {
    const plan =
      getPlanDefinition(user);

    const result =
      await enforceUserPlanLimits(
        user.id,
        plan
      );

    if (
      result.disabledTriggerCount > 0 ||
      result.disabledSourceCount > 0
    ) {
      console.log(
        "USER_PLAN_LIMITS_ENFORCED",
        {
          userId: user.id,
          telegramId: user.telegramId,
          planCode: plan.code,
          disabledTriggerCount:
            result.disabledTriggerCount,
          disabledSourceCount:
            result.disabledSourceCount
        }
      );
    }
  }
}

async function getRegisteredUserByTelegramId(
  telegramId: string
) {
  return prisma.botUser.findUnique({
    where: {
      telegramId
    },
    select: {
      id: true,
      telegramId: true,
      role: true,
      isActive: true,
      deliveryChatId: true,
      subscription: {
        select: {
          planCode: true,
          status: true,
          expiresAt: true
        }
      }
    }
  });
}

async function getPersonalTriggerRecipients(
  ctx: Context,
  text: string
): Promise<PersonalTriggerRecipient[]> {
  const chat = ctx.chat;

  if (!chat || chat.type === "private") {
    return [];
  }

  const normalizedText = normalizePlain(text);

  if (!normalizedText) {
    return [];
  }

  const connections = await prisma.userSourceChat.findMany({
    where: {
      chatId: String(chat.id),
      isActive: true
    },
    select: {
      user: {
        select: {
          id: true,
          telegramId: true,
          role: true,
          isActive: true,
          deliveryChatId: true,
          subscription: {
            select: {
              status: true,
              expiresAt: true
            }
          },
          triggers: {
            where: {
              isActive: true
            },
            select: {
              phrase: true,
              normalizedPhrase: true
            }
          }
        }
      }
    }
  });

  const recipients: PersonalTriggerRecipient[] = [];

  for (const connection of connections) {
    const user = connection.user;

    if (!user.deliveryChatId) continue;
    if (!hasSubscriptionAccess(user)) continue;

    const matchedTriggers = user.triggers
      .filter((trigger) =>
        normalizedText.includes(trigger.normalizedPhrase)
      )
      .map((trigger) => trigger.phrase);

    if (!matchedTriggers.length) continue;

    recipients.push({
      userId: user.id,
      telegramId: user.telegramId,
      deliveryChatId: user.deliveryChatId,
      matchedTriggers: [...new Set(matchedTriggers)]
    });
  }

  return recipients;
}

function createTriggerOnlyDetection(
  matchedTriggers: string[]
): LeadDetectionResult {
  return {
    score: Math.min(
      10,
      Math.max(3, 2 + matchedTriggers.length)
    ),
    matched: matchedTriggers.map(
      (trigger) => `Персональный триггер: ${trigger}`
    ),
    negativeMatched: [],
    category: "unknown"
  };
}

function getPersonalDisplayStatus(
  delivery: PersonalLeadDeliveryData
): DisplayStatus {
  const displayStatus = getDisplayStatus({
    status: delivery.status,
    createdAt: delivery.lead.createdAt,
    lastTriggeredAt: delivery.lead.lastTriggeredAt
  });

  if (delivery.status === LeadStatus.NEW) {
    return {
      ...displayStatus,
      emoji: "🆕",
      label: "Новая"
    };
  }

  return displayStatus;
}

function buildPersonalLeadKeyboard(
  delivery: PersonalLeadDeliveryData
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const lead = delivery.lead;

  keyboard
    .text(
      `🔁 Сработок от клиента: ${lead.triggerCount}`,
      `pcount:${lead.id}`
    )
    .row();

  if (lead.messageUrl) {
    keyboard
      .url("Открыть сообщение", lead.messageUrl)
      .row();
  }

  if (lead.authorUsername) {
    keyboard
      .url(
        "Написать клиенту",
        `https://t.me/${lead.authorUsername}`
      )
      .row();
  }

  if (delivery.status === LeadStatus.NEW) {
    keyboard
      .text(
        "Связался",
        `pstatus:contacted:${lead.id}`
      )
      .text(
        "Ждём ответ",
        `pstatus:waiting:${lead.id}`
      )
      .row()
      .text(
        "В работу",
        `pstatus:won:${lead.id}`
      )
      .text(
        "Игнор",
        `pstatus:ignored:${lead.id}`
      );
  } else if (
    delivery.status === LeadStatus.WON
  ) {
    keyboard
      .text(
        "Обработано",
        `pstatus:contacted:${lead.id}`
      )
      .text(
        "Ждём ответ",
        `pstatus:waiting:${lead.id}`
      )
      .row()
      .text(
        "В обсуждении",
        `pstatus:progress:${lead.id}`
      )
      .text(
        "Отказ",
        `pstatus:lost:${lead.id}`
      )
      .row()
      .text(
        "Игнор",
        `pstatus:ignored:${lead.id}`
      );
  } else if (
    pipelineLeadStatuses.has(delivery.status)
  ) {
    keyboard
      .text(
        "Ждём ответ",
        `pstatus:waiting:${lead.id}`
      )
      .text(
        "В обсуждении",
        `pstatus:progress:${lead.id}`
      )
      .row()
      .text(
        "В работу",
        `pstatus:won:${lead.id}`
      )
      .text(
        "Отказ",
        `pstatus:lost:${lead.id}`
      )
      .row()
      .text(
        "Игнор",
        `pstatus:ignored:${lead.id}`
      );
  } else if (
    delivery.status === LeadStatus.IGNORED
  ) {
    keyboard
      .text(
        "♻️ Восстановить",
        `prestore:${lead.id}`
      )
      .text(
        "🗑 Удалить",
        `pdelete:${lead.id}`
      );
  } else if (
    delivery.status === LeadStatus.DELETED
  ) {
    keyboard.text(
      "♻️ Восстановить",
      `prestore:${lead.id}`
    );
  }

  return keyboard;
}

function normalizePersonalLeadType(
  value: string
): string | null {
  let result = value
    .replace(
      /^(?:нужен|нужна|нужно|нужны|ищу|требуется|требуются|надо|необходим|необходима|необходимы)\s+/i,
      ""
    )
    .replace(
      /^(?:кто\s+(?:может|сможет)\s+|посоветуйте\s+|подскажите\s+)/i,
      ""
    )
    .replace(/[.,!?;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!result) return null;

  result =
    result.charAt(0).toUpperCase() +
    result.slice(1);

  return result.slice(0, 70);
}

function getPersonalLeadType(
  delivery: PersonalLeadDeliveryData
): string {
  const lead = delivery.lead;

  if (lead.category !== LeadCategory.UNKNOWN) {
    return inferLeadType(
      lead.messageText,
      lead.category
    );
  }

  for (const trigger of delivery.matchedTriggers) {
    const triggerType =
      normalizePersonalLeadType(trigger);

    if (triggerType) {
      return triggerType;
    }
  }

  const messageType =
    normalizePersonalLeadType(
      lead.messageText
    );

  return (
    messageType ??
    "Запрос по персональному триггеру"
  );
}

function formatPersonalLeadNotification(
  delivery: PersonalLeadDeliveryData
): string {
  const gap = "\u200B";
  const lead = delivery.lead;

  const status =
    getPersonalDisplayStatus(delivery);

  const leadType =
    getPersonalLeadType(delivery);

  const displayScore = Math.max(
    0,
    Math.min(10, lead.score)
  );

  const safeText =
    lead.messageText.length > 1000
      ? `${lead.messageText.slice(0, 1000)}...`
      : lead.messageText;

  const authorName =
    lead.authorName ?? "Без имени";

  const authorTelegram =
    lead.authorUsername
      ? `@${lead.authorUsername}`
      : "username скрыт";

  const authorId =
    lead.authorTelegramId ??
    "неизвестен";

  const authorProfileUrl =
    lead.authorUsername
      ? `https://t.me/${lead.authorUsername}`
      : null;

  const clientTitle =
    authorProfileUrl
      ? `<a href="${escapeHtml(
          authorProfileUrl
        )}">${escapeHtml(authorName)}</a>`
      : escapeHtml(authorName);

  const sourceTitle =
    lead.messageUrl
      ? `<a href="${escapeHtml(
          lead.messageUrl
        )}">${escapeHtml(
          lead.sourceChatTitle
        )}</a>`
      : escapeHtml(lead.sourceChatTitle);

  return [
    "🔥 <b>Горячий клиент</b>",
    gap,

    `📌 <b>Тип:</b> ${escapeHtml(
      leadType
    )}`,
    `${status.emoji} <b>Статус:</b> ${escapeHtml(
      status.label
    )}`,
    `⭐ <b>Оценка:</b> ${displayScore}/10`,
    gap,

    `💬 <b>Запрос клиента</b> — «${escapeHtml(
      safeText
    )}»`,
    gap,

    `👤 <b>Клиент:</b> ${clientTitle} | ${escapeHtml(
      authorTelegram
    )} | ID: <code>${escapeHtml(
      authorId
    )}</code>`,
    gap,

    `📍 <b>Источник</b> — ${sourceTitle}`,
    gap,

    "🎯 <b>Почему сработало</b>",
    formatBulletList(
      delivery.matchedTriggers
    ),

    delivery.note
      ? [
          "",
          "📝 <b>Заметка</b>",
          escapeHtml(delivery.note)
        ].join("\n")
      : null,

    gap,

    "🧾 <b>Технически</b>",
    `Lead ID: <code>${escapeHtml(
      getShortLeadId(lead.id)
    )}</code>`
  ]
    .filter(Boolean)
    .join("\n");
}

function getPersonalLeadSendOptions(
  delivery: PersonalLeadDeliveryData
) {
  return {
    reply_markup:
      buildPersonalLeadKeyboard(delivery),
    parse_mode: "HTML" as const,
    link_preview_options: {
      is_disabled: true
    }
  };
}

function formatPersonalLeadList(
  title: string,
  deliveries: PersonalLeadDeliveryData[]
): string {
  if (!deliveries.length) {
    return `${title}\n\nСписок пуст.`;
  }

  const items = deliveries.map(
    (delivery, index) => {
      const lead = delivery.lead;
      const status =
        getPersonalDisplayStatus(delivery);

      const leadType = inferLeadType(
        lead.messageText,
        lead.category
      );

      const authorName =
        lead.authorName ?? "Без имени";

      const authorUsername =
        lead.authorUsername
          ? `@${lead.authorUsername}`
          : "username скрыт";

      const shortText =
        lead.messageText.length > 120
          ? `${lead.messageText.slice(0, 120)}...`
          : lead.messageText;

      return [
        `${index + 1}. <code>${escapeHtml(
          getShortLeadId(lead.id)
        )}</code> — ${escapeHtml(leadType)}`,
        `${status.emoji} ${escapeHtml(
          status.label
        )}`,
        `👤 ${escapeHtml(
          authorName
        )} | ${escapeHtml(authorUsername)}`,
        `💬 «${escapeHtml(shortText)}»`
      ].join("\n");
    }
  );

  return [
    title,
    "",
    items.join("\n\n")
  ].join("\n");
}

function buildPersonalLeadListKeyboard(
  deliveries: PersonalLeadDeliveryData[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const delivery of deliveries) {
    keyboard
      .text(
        `Открыть ${getShortLeadId(
          delivery.lead.id
        )}`,
        `pshow:${delivery.lead.id}`
      )
      .row();
  }

  return keyboard;
}

function buildPersonalArchiveKeyboard(
  deliveries: PersonalLeadDeliveryData[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const delivery of deliveries) {
    const leadId = delivery.lead.id;

    keyboard
      .text(
        `Открыть ${getShortLeadId(leadId)}`,
        `pshow:${leadId}`
      )
      .row()
      .text(
        "♻️ Восстановить",
        `parchive-restore:${leadId}`
      )
      .text(
        "🗑 Удалить",
        `parchive-delete:${leadId}`
      )
      .row();
  }

  return keyboard;
}

async function getPersonalDeliveryByLeadId(
  userId: string,
  leadIdOrShortId: string
): Promise<PersonalLeadDeliveryData | null> {
  const normalizedId =
    leadIdOrShortId.trim();

  if (!normalizedId) return null;

  return prisma.leadDelivery.findFirst({
    where: {
      recipientUserId: userId,
      deliveryType:
        LeadDeliveryType.USER_TRIGGER,
      OR: [
        {
          leadId: normalizedId
        },
        {
          leadId: {
            endsWith: normalizedId
          }
        }
      ]
    },
    orderBy: {
      updatedAt: "desc"
    },
    select: personalLeadDeliverySelect
  });
}

async function requirePersonalBotUser(
  ctx: Context
) {
  const user = await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.reply(
      "Сначала зарегистрируйтесь через /start."
    );
    return null;
  }

  if (!hasSubscriptionAccess(user)) {
    await ctx.reply(
      "Ваша подписка неактивна или пробный период закончился."
    );
    return null;
  }

  return user;
}

async function editPersonalLeadMessage(
  ctx: Context,
  delivery: PersonalLeadDeliveryData
): Promise<void> {
  await ctx
    .editMessageText(
      formatPersonalLeadNotification(delivery),
      getPersonalLeadSendOptions(delivery)
    )
    .catch((error) => {
      const message = String(error);

      if (
        !message.includes(
          "message is not modified"
        )
      ) {
        console.error(
          "PERSONAL_LEAD_MESSAGE_EDIT_ERROR",
          {
            deliveryId: delivery.id,
            leadId: delivery.leadId,
            error
          }
        );
      }
    });
}

function formatPersonalArchiveDeletionTimer(
  delivery: PersonalLeadDeliveryData,
  secondsLeft: number
): string {
  const totalSeconds = 10;

  const safeSecondsLeft = Math.max(
    0,
    Math.min(totalSeconds, secondsLeft)
  );

  const filled = "●".repeat(
    totalSeconds - safeSecondsLeft
  );

  const empty = "○".repeat(
    safeSecondsLeft
  );

  return [
    "🗄 <b>Заявка отправлена в архив</b>",
    "",
    `Lead ID: <code>${escapeHtml(
      getShortLeadId(delivery.lead.id)
    )}</code>`,
    "",
    safeSecondsLeft > 0
      ? `⏳ <b>Удаление сообщения через:</b> ${safeSecondsLeft} сек`
      : "🧹 <b>Удаляю сообщение...</b>",
    `${filled}${empty}`,
    "",
    "Заявка останется в вашем архиве.",
    "Открыть архив: /archive"
  ].join("\n");
}

async function animatePersonalArchiveDeletion(
  ctx: Context,
  delivery: PersonalLeadDeliveryData
): Promise<void> {
  for (
    let secondsLeft = 10;
    secondsLeft >= 1;
    secondsLeft--
  ) {
    await ctx
      .editMessageText(
        formatPersonalArchiveDeletionTimer(
          delivery,
          secondsLeft
        ),
        {
          parse_mode: "HTML",
          reply_markup: undefined,
          link_preview_options: {
            is_disabled: true
          }
        }
      )
      .catch((error) => {
        console.error(
          "PERSONAL_ARCHIVE_TIMER_ERROR",
          {
            deliveryId: delivery.id,
            secondsLeft,
            error
          }
        );
      });

    await sleep(1000);
  }

  await ctx
    .editMessageText(
      formatPersonalArchiveDeletionTimer(
        delivery,
        0
      ),
      {
        parse_mode: "HTML",
        reply_markup: undefined,
        link_preview_options: {
          is_disabled: true
        }
      }
    )
    .catch(() => undefined);

  await sleep(500);

  await ctx
    .deleteMessage()
    .catch((error) => {
      console.error(
        "PERSONAL_ARCHIVE_DELETE_ERROR",
        {
          deliveryId: delivery.id,
          error
        }
      );
    });
}

async function sendPersonalLeadCard(
  delivery: PersonalLeadDeliveryData
): Promise<void> {
  const sentMessage =
    await bot.api.sendMessage(
      delivery.recipientChatId,
      formatPersonalLeadNotification(delivery),
      getPersonalLeadSendOptions(delivery)
    );

  await prisma.leadDelivery.update({
    where: {
      id: delivery.id
    },
    data: {
      telegramMessageId:
        sentMessage.message_id
    }
  });
}

async function deliverOwnerGlobalLead(
  lead: LeadNotificationData
): Promise<void> {
  const owner =
    await prisma.botUser.findUnique({
      where: {
        telegramId: ownerTelegramUserId
      },
      select: {
        id: true
      }
    });

  let telegramMessageId =
    lead.adminChatId === adminTargetChatId
      ? lead.adminMessageId
      : null;

  if (telegramMessageId) {
    const edited = await bot.api
      .editMessageText(
        adminTargetChatId,
        telegramMessageId,
        formatLeadNotification(lead),
        getSendOptions(lead)
      )
      .then(() => true)
      .catch(() => false);

    if (!edited) {
      telegramMessageId = null;
    }
  }

  if (!telegramMessageId) {
    const sentMessage =
      await bot.api.sendMessage(
        adminTargetChatId,
        formatLeadNotification(lead),
        getSendOptions(lead)
      );

    telegramMessageId =
      sentMessage.message_id;
  }

  await prisma.lead.update({
    where: {
      id: lead.id
    },
    data: {
      adminChatId: adminTargetChatId,
      adminMessageId: telegramMessageId
    }
  });

  await prisma.leadDelivery.upsert({
    where: {
      leadId_recipientChatId: {
        leadId: lead.id,
        recipientChatId:
          adminTargetChatId
      }
    },
    update: {
      recipientUserId: owner?.id ?? null,
      deliveryType:
        LeadDeliveryType.OWNER_GLOBAL,
      matchedTriggers: [],
      telegramMessageId
    },
    create: {
      leadId: lead.id,
      recipientUserId: owner?.id ?? null,
      recipientChatId:
        adminTargetChatId,
      deliveryType:
        LeadDeliveryType.OWNER_GLOBAL,
      matchedTriggers: [],
      telegramMessageId,
      status: LeadStatus.NEW
    }
  });
}

async function deliverPersonalTriggerLead(
  lead: LeadNotificationData,
  recipient: PersonalTriggerRecipient
): Promise<void> {
  const existing =
    await prisma.leadDelivery.findUnique({
      where: {
        leadId_recipientChatId: {
          leadId: lead.id,
          recipientChatId:
            recipient.deliveryChatId
        }
      },
      select: {
        deliveryType: true,
        matchedTriggers: true
      }
    });

  if (
    existing?.deliveryType ===
    LeadDeliveryType.OWNER_GLOBAL
  ) {
    return;
  }

  const isRepeatDelivery =
    existing?.deliveryType ===
    LeadDeliveryType.USER_TRIGGER;

  const matchedTriggers = [
    ...new Set([
      ...(existing?.matchedTriggers ?? []),
      ...recipient.matchedTriggers
    ])
  ];

  const delivery =
    await prisma.leadDelivery.upsert({
      where: {
        leadId_recipientChatId: {
          leadId: lead.id,
          recipientChatId:
            recipient.deliveryChatId
        }
      },
      update: {
        recipientUserId:
          recipient.userId,
        deliveryType:
          LeadDeliveryType.USER_TRIGGER,
        matchedTriggers
      },
      create: {
        leadId: lead.id,
        recipientUserId:
          recipient.userId,
        recipientChatId:
          recipient.deliveryChatId,
        deliveryType:
          LeadDeliveryType.USER_TRIGGER,
        matchedTriggers,
        status: LeadStatus.NEW
      },
      select: personalLeadDeliverySelect
    });

  let telegramMessageId =
    delivery.telegramMessageId;

  if (telegramMessageId) {
    const edited = await bot.api
      .editMessageText(
        recipient.deliveryChatId,
        telegramMessageId,
        formatPersonalLeadNotification(
          delivery
        ),
        getPersonalLeadSendOptions(
          delivery
        )
      )
      .then(() => true)
      .catch(() => false);

    if (!edited) {
      telegramMessageId = null;
    }
  }

  if (!telegramMessageId) {
    const sentMessage =
      await bot.api.sendMessage(
        recipient.deliveryChatId,
        formatPersonalLeadNotification(
          delivery
        ),
        getPersonalLeadSendOptions(
          delivery
        )
      );

    telegramMessageId =
      sentMessage.message_id;
  }

  await prisma.leadDelivery.update({
    where: {
      id: delivery.id
    },
    data: {
      telegramMessageId
    }
  });

  if (isRepeatDelivery) {
    const repeatNotice = await bot.api
      .sendMessage(
        recipient.deliveryChatId,
        [
          "🔁 Клиент написал повторно",
          "",
          `Сработок от клиента: ${lead.triggerCount}`,
          `Lead ID: ${getShortLeadId(lead.id)}`
        ].join("\n")
      )
      .catch((error) => {
        console.error(
          "PERSONAL_REPEAT_NOTICE_ERROR",
          {
            leadId: lead.id,
            recipientUserId:
              recipient.userId,
            recipientChatId:
              recipient.deliveryChatId,
            error
          }
        );

        return null;
      });

    if (repeatNotice) {
      console.log(
        "PERSONAL_REPEAT_NOTICE_SENT",
        {
          leadId: lead.id,
          recipientUserId:
            recipient.userId,
          recipientChatId:
            recipient.deliveryChatId,
          triggerCount:
            lead.triggerCount
        }
      );

      setTimeout(() => {
        void bot.api
          .deleteMessage(
            repeatNotice.chat.id,
            repeatNotice.message_id
          )
          .catch((error) => {
            console.error(
              "PERSONAL_REPEAT_NOTICE_DELETE_ERROR",
              {
                leadId: lead.id,
                chatId:
                  repeatNotice.chat.id,
                messageId:
                  repeatNotice.message_id,
                error
              }
            );
          });
      }, 5000);
    }
  }
}

async function findLeadById(leadIdOrShortId: string): Promise<LeadNotificationData | null> {
  const normalizedId = leadIdOrShortId.trim();
  if (!normalizedId) return null;

  return prisma.lead.findFirst({
    where: {
      OR: [
        { id: normalizedId },
        { id: { endsWith: normalizedId } }
      ]
    },
    orderBy: {
      updatedAt: "desc"
    },
    select: leadNotificationSelect
  });
}

async function trackSourceChat(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") return;

  await prisma.sourceChat.upsert({
    where: {
      chatId: String(ctx.chat.id)
    },
    update: {
      title: getChatTitle(ctx)
    },
    create: {
      chatId: String(ctx.chat.id),
      title: getChatTitle(ctx)
    }
  });
}

async function isSourceChatBlocked(ctx: Context): Promise<boolean> {
  if (!ctx.chat || ctx.chat.type === "private") return false;

  const sourceChat = await prisma.sourceChat.findUnique({
    where: {
      chatId: String(ctx.chat.id)
    },
    select: {
      isBlocked: true
    }
  });

  return sourceChat?.isBlocked ?? false;
}

async function isUserBanned(ctx: Context): Promise<boolean> {
  if (!ctx.from) return false;

  const bannedUser = await prisma.bannedUser.findUnique({
    where: {
      telegramId: String(ctx.from.id)
    },
    select: {
      id: true
    }
  });

  return Boolean(bannedUser);
}

async function findMatchedBlackWord(text: string): Promise<string | null> {
  const normalizedText = normalizePlain(text);

  const words = await prisma.blackWord.findMany({
    select: {
      phrase: true
    }
  });

  const matched = words.find((word) => normalizedText.includes(normalizePlain(word.phrase)));
  return matched?.phrase ?? null;
}

async function createOrUpdateLeadWithSpamGuard(
  ctx: Context,
  lead: LeadDetectionResult,
  text: string,
  scopeKey: string,
  allowAuthorMerge = true
): Promise<LeadHandleResult> {
  const chat = ctx.chat;
  const messageId = ctx.message?.message_id;

  if (!chat || !messageId) return { action: "skip", lead: null };

  const sourceChatId = String(chat.id);

  // У владельца открытость заявки определяется Lead.status.
  // У пользователя дополнительно проверяется его личный
  // LeadDelivery.status.
  const mergeScopeFilter =
    scopeKey.startsWith("USER:")
      ? {
          deliveries: {
            some: {
              deliveryType:
                LeadDeliveryType.USER_TRIGGER,
              status: LeadStatus.NEW
            }
          }
        }
      : {};

  const exactDuplicate = await prisma.lead.findUnique({
    where: {
      sourceChatId_sourceMessageId_scopeKey: {
        sourceChatId,
        sourceMessageId: messageId,
        scopeKey
      }
    },
    select: {
      id: true
    }
  });

  if (exactDuplicate) return { action: "skip", lead: null };

  const authorTelegramId = ctx.from ? String(ctx.from.id) : null;

  if (authorTelegramId && allowAuthorMerge) {
    const recentLead = await prisma.lead.findFirst({
      where: {
        scopeKey,
        authorTelegramId,
        status: LeadStatus.NEW,
        ...mergeScopeFilter,
        triggerCount: {
          lt: spamMaxTriggers
        },
        lastTriggeredAt: {
          gte: new Date(Date.now() - spamWindowMs)
        }
      },
      orderBy: {
        lastTriggeredAt: "desc"
      },
      select: leadNotificationSelect
    });

    if (recentLead) {
      const updatedLead = await prisma.lead.update({
        where: {
          id: recentLead.id
        },
        data: {
          sourceChatId,
          sourceChatTitle: getChatTitle(ctx),
          sourceMessageId: messageId,
          messageText: text,
          matchedKeywords: lead.matched,
          negativeKeywords: lead.negativeMatched,
          score: lead.score,
          category: toDbCategory(lead.category),
          authorUsername: getAuthorUsername(ctx),
          authorName: getAuthorName(ctx),
          messageUrl: getMessageUrl(ctx),
          triggerCount: {
            increment: 1
          },
          lastTriggeredAt: new Date()
        },
        select: leadNotificationSelect
      });

      return { action: "update", lead: updatedLead };
    }

    const cappedRecentLead = await prisma.lead.findFirst({
      where: {
        scopeKey,
        authorTelegramId,
        status: LeadStatus.NEW,
        ...mergeScopeFilter,
        triggerCount: {
          gte: spamMaxTriggers
        },
        lastTriggeredAt: {
          gte: new Date(Date.now() - spamWindowMs)
        }
      },
      orderBy: {
        lastTriggeredAt: "desc"
      },
      select: {
        id: true,
        triggerCount: true
      }
    });

    if (cappedRecentLead) {
      console.log("LEAD_SPAM_CAP_REACHED", {
        leadId: cappedRecentLead.id,
        triggerCount: cappedRecentLead.triggerCount,
        authorTelegramId
      });

      return { action: "skip", lead: null };
    }
  }

  const createdLead = await prisma.lead.create({
    data: {
      scopeKey,
      sourceChatId,
      sourceChatTitle: getChatTitle(ctx),
      sourceMessageId: messageId,
      messageText: text,
      matchedKeywords: lead.matched,
      negativeKeywords: lead.negativeMatched,
      score: lead.score,
      category: toDbCategory(lead.category),
      authorTelegramId,
      authorUsername: getAuthorUsername(ctx),
      authorName: getAuthorName(ctx),
      messageUrl: getMessageUrl(ctx),
      triggerCount: 1,
      lastTriggeredAt: new Date(),
      status: LeadStatus.NEW
    },
    select: leadNotificationSelect
  });

  return { action: "send", lead: createdLead };
}

function formatArchiveDeletionTimer(lead: LeadNotificationData, secondsLeft: number): string {
  const totalSeconds = 10;
  const safeSecondsLeft = Math.max(0, Math.min(totalSeconds, secondsLeft));
  const filled = "●".repeat(totalSeconds - safeSecondsLeft);
  const empty = "○".repeat(safeSecondsLeft);
  const progress = `${filled}${empty}`;

  return [
    "🗄 <b>Заявка отправлена в архив</b>",
    "",
    `Lead ID: <code>${escapeHtml(getShortLeadId(lead.id))}</code>`,
    "",
    safeSecondsLeft > 0
      ? `⏳ <b>Удаление сообщения через:</b> ${safeSecondsLeft} сек`
      : "🧹 <b>Удаляю сообщение...</b>",
    progress,
    "",
    "Заявка останется в БД.",
    "Восстановить можно через:",
    "/archive"
  ].join("\n");
}

async function animateArchiveDeletion(ctx: Context, lead: LeadNotificationData): Promise<void> {
  for (let secondsLeft = 10; secondsLeft >= 1; secondsLeft--) {
    await ctx
      .editMessageText(formatArchiveDeletionTimer(lead, secondsLeft), {
        parse_mode: "HTML",
        reply_markup: undefined,
        link_preview_options: {
          is_disabled: true
        }
      })
      .catch((error) => {
        console.error("LEAD_IGNORE_TIMER_EDIT_ERROR", {
          leadId: lead.id,
          secondsLeft,
          error
        });
      });

    await sleep(1000);
  }

  await ctx
    .editMessageText(formatArchiveDeletionTimer(lead, 0), {
      parse_mode: "HTML",
      reply_markup: undefined,
      link_preview_options: {
        is_disabled: true
      }
    })
    .catch((error) => {
      console.error("LEAD_IGNORE_TIMER_FINAL_EDIT_ERROR", {
        leadId: lead.id,
        error
      });
    });

  await sleep(500);

  await ctx.deleteMessage().catch((error) => {
    console.error("LEAD_IGNORE_DELETE_MESSAGE_ERROR", {
      leadId: lead.id,
      error
    });
  });
}

function formatLeadList(title: string, leads: LeadNotificationData[]): string {
  if (!leads.length) {
    return `${title}\n\nСписок пуст.`;
  }

  const items = leads.map((lead, index) => {
    const leadType = inferLeadType(lead.messageText, lead.category);
    const status = getDisplayStatus(lead);
    const authorName = lead.authorName ?? "Без имени";
    const authorUsername = lead.authorUsername ? `@${lead.authorUsername}` : "username скрыт";
    const shortText =
      lead.messageText.length > 120
        ? `${lead.messageText.slice(0, 120)}...`
        : lead.messageText;

    return [
      `${index + 1}. <code>${escapeHtml(getShortLeadId(lead.id))}</code> — ${escapeHtml(leadType)} — ${lead.score}/10`,
      `${status.emoji} ${escapeHtml(status.label)}`,
      `👤 ${escapeHtml(authorName)} | ${escapeHtml(authorUsername)}`,
      `🔁 Сработок: ${lead.triggerCount}`,
      `💬 «${escapeHtml(shortText)}»`
    ].join("\n");
  });

  return [title, "", items.join("\n\n")].join("\n");
}

function buildLeadListKeyboard(leads: LeadNotificationData[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const lead of leads) {
    keyboard
      .text(`Открыть ${getShortLeadId(lead.id)}`, `show:${lead.id}`)
      .text("Связался", `status:contacted:${lead.id}`)
      .text("Игнор", `status:ignored:${lead.id}`)
      .row();
  }

  return keyboard;
}

function buildArchiveKeyboard(leads: LeadNotificationData[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const lead of leads) {
    keyboard
      .text(`♻️ Восстановить ${getShortLeadId(lead.id)}`, `restore:${lead.id}`)
      .text("🗑", `delete-archived:${lead.id}`)
      .row();
  }

  return keyboard;
}

function buildTrashKeyboard(leads: LeadNotificationData[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const lead of leads) {
    keyboard.text(`♻️ Восстановить ${getShortLeadId(lead.id)}`, `restore:${lead.id}`).row();
  }

  return keyboard;
}

async function restoreArchivedLead(leadId: string): Promise<LeadNotificationData | null> {
  const lead = await prisma.lead.findUnique({
    where: {
      id: leadId
    },
    select: leadNotificationSelect
  });

  if (!lead || !restorableLeadStatuses.has(lead.status)) {
    return null;
  }

  const restoredLead = await prisma.lead.update({
    where: {
      id: leadId
    },
    data: {
      status: LeadStatus.NEW,
      lastTriggeredAt: new Date()
    },
    select: leadNotificationSelect
  });

  const sentMessage = await bot.api.sendMessage(
    adminTargetChatId,
    formatLeadNotification(restoredLead),
    getSendOptions(restoredLead)
  );

  const activeLead = await prisma.lead.update({
    where: {
      id: leadId
    },
    data: {
      adminChatId: adminTargetChatId,
      adminMessageId: sentMessage.message_id
    },
    select: leadNotificationSelect
  });

  scheduleHotLeadRefresh(activeLead.id, activeLead.lastTriggeredAt);

  console.log("LEAD_RESTORED_FROM_ARCHIVE", {
    leadId: activeLead.id,
    triggerCount: activeLead.triggerCount,
    authorTelegramId: activeLead.authorTelegramId
  });

  return activeLead;
}

async function softDeleteArchivedLead(leadId: string): Promise<LeadNotificationData | null> {
  const lead = await prisma.lead.findUnique({
    where: {
      id: leadId
    },
    select: leadNotificationSelect
  });

  if (!lead || lead.status !== LeadStatus.IGNORED) {
    return null;
  }

  const deletedLead = await prisma.lead.update({
    where: {
      id: leadId
    },
    data: {
      status: LeadStatus.DELETED
    },
    select: leadNotificationSelect
  });

  console.log("LEAD_SOFT_DELETED_FROM_ARCHIVE", {
    leadId: deletedLead.id,
    triggerCount: deletedLead.triggerCount,
    authorTelegramId: deletedLead.authorTelegramId
  });

  return deletedLead;
}

function scheduleHotLeadRefresh(leadId: string, fromDate: Date): void {
  const existingTimer = scheduledHotRefreshes.get(leadId);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const elapsed = Date.now() - fromDate.getTime();
  const delay = hotLeadMs - elapsed;

  if (delay <= 0) return;

  const timer = setTimeout(() => {
    scheduledHotRefreshes.delete(leadId);
    void refreshHotLeadMessage(leadId);
  }, delay + 1000);

  scheduledHotRefreshes.set(leadId, timer);
}

async function refreshHotLeadMessage(leadId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({
    where: {
      id: leadId
    },
    select: leadNotificationSelect
  });

  if (!lead) return;
  if (lead.status !== LeadStatus.NEW) return;
  if (!lead.adminChatId || !lead.adminMessageId) return;

  await bot.api
    .editMessageText(lead.adminChatId, lead.adminMessageId, formatLeadNotification(lead), getSendOptions(lead))
    .catch((error) => {
      console.error("HOT_LEAD_REFRESH_ERROR", {
        leadId,
        error
      });
    });
}

const paymentExpirySweepIntervalMs =
  5 * 60 * 1000;

let paymentExpirySweepTimer:
  ReturnType<typeof setInterval> | null =
    null;

async function expireStalePayments(): Promise<number> {
  const now =
    new Date();

  const result =
    await prisma.payment.updateMany({
      where: {
        activatedAt: null,
        expiresAt: {
          lte: now
        },
        status: {
          in: [
            PaymentStatus.CREATED,
            PaymentStatus.PENDING
          ]
        }
      },
      data: {
        status:
          PaymentStatus.EXPIRED,
        failureReason:
          "Истёк срок действия платёжного заказа"
      }
    });

  if (result.count > 0) {
    console.log(
      "PAYMENT_ORDERS_EXPIRED",
      {
        count: result.count,
        checkedAt:
          now.toISOString()
      }
    );
  }

  return result.count;
}

function startPaymentExpirySweeper(): void {
  if (paymentExpirySweepTimer) {
    clearInterval(
      paymentExpirySweepTimer
    );
  }

  paymentExpirySweepTimer =
    setInterval(() => {
      void expireStalePayments()
        .catch((error) => {
          console.error(
            "PAYMENT_EXPIRY_SWEEP_ERROR",
            error
          );
        });
    }, paymentExpirySweepIntervalMs);

  paymentExpirySweepTimer.unref();
}

async function schedulePendingHotLeadRefreshes(): Promise<void> {
  const leads = await prisma.lead.findMany({
    where: {
      status: LeadStatus.NEW,
      lastTriggeredAt: {
        gte: new Date(Date.now() - hotLeadMs)
      },
      adminChatId: {
        not: null
      },
      adminMessageId: {
        not: null
      }
    },
    select: {
      id: true,
      lastTriggeredAt: true
    }
  });

  for (const lead of leads) {
    scheduleHotLeadRefresh(lead.id, lead.lastTriggeredAt);
  }

  console.log(`Scheduled hot lead refreshes: ${leads.length}`);
}

bot.command("start", async (ctx) => {
  const registration = await registerBotUser(ctx);

  if (!registration) {
    await ctx.reply(
      "Откройте личный чат с ботом и повторите /start."
    );
    return;
  }

  if (!assertAdmin(ctx)) {
    const { user, subscription } = registration;

    if (!user.isActive) {
      await ctx.reply(
        [
          "🚫 Ваш аккаунт отключён.",
          "",
          "Для восстановления доступа обратитесь к владельцу бота."
        ].join("\n")
      );
      return;
    }

    const plan = getPlanDefinition({
      role: user.role,
      subscription
    });

    const statusLabel =
      getEffectiveSubscriptionStatusLabel(
        subscription.status,
        subscription.expiresAt
      );

    const hasAccess =
      hasSubscriptionAccess({
        ...user,
        subscription
      });

    if (!hasAccess) {
      await ctx.reply(
        [
          "👋 <b>Подписка неактивна</b>",
          "",
          `Тариф: ${escapeHtml(plan.label)}`,
          `Статус подписки: ${escapeHtml(statusLabel)}`,
          "Доступ: ⛔ приостановлен",
          `Доступ до: ${escapeHtml(
            formatAccessDate(
              subscription.expiresAt
            )
          )}`,
          "",
          "Ваши данные, источники, триггеры и история лидов сохранены.",
          "",
          "Для восстановления доступа выберите тариф или обратитесь к владельцу бота.",
          "",
          "Доступные команды:",
          "/profile — профиль и использование",
          "/subscription — состояние подписки",
          "/plans — доступные тарифы",
          "/paysupport — поддержка по оплате",
          "/terms — условия использования и оплаты",
          "/id — показать ваш Telegram ID"
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup:
            buildInactiveSubscriptionKeyboard()
        }
      );
      return;
    }

    await ctx.reply(
      [
        "👋 <b>Добро пожаловать!</b>",
        "",
        "Ваш аккаунт активен.",
        "",
        `Тариф: ${escapeHtml(plan.label)}`,
        `Статус подписки: ${escapeHtml(statusLabel)}`,
        `Доступ до: ${escapeHtml(
          formatAccessDate(
            subscription.expiresAt
          )
        )}`,
        "",
        "Доступные команды:",
        "/profile — профиль и использование",
        "/subscription — состояние подписки",
        "/plans — доступные тарифы",
        "/paysupport — поддержка по оплате",
        "/terms — условия использования и оплаты",
        "/triggers — мои триггеры",
        "/addtrigger фраза — добавить триггер",
        "/removetrigger фраза — удалить триггер",
        "/sources — подключённые группы",
        "/connectchat — подключить текущую группу",
        "/disconnectchat chat_id — отключить группу",
        "/stats — личная статистика",
        "/leads — активные заявки",
        "/work — заявки в работе",
        "/lead LeadID — открыть заявку",
        "/archive — архив",
        "/trash — удалённые заявки",
        "/restore LeadID — восстановить",
        "/note LeadID текст — добавить заметку",
        "/id — показать ваш Telegram ID"
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: buildUserMainKeyboard()
      }
    );
    return;
  }

  await ctx.reply(
    [
      "👑 Панель владельца @rilfok",
      "",
      `Telegram ID: ${ownerTelegramUserId}`,
      `Чат уведомлений: ${adminTargetChatId}`,
      "Роль: OWNER",
      "Доступ: бессрочный",
      "",
      "Команды:",
      "/profile — профиль и использование",
      "/subscription — состояние подписки",
      "/plans — доступные тарифы",
      "/paysupport — поддержка по оплате",
      "/terms — условия использования и оплаты",
      "/triggers — персональные триггеры",
      "/addtrigger фраза — добавить триггер",
      "/removetrigger фраза — удалить триггер",
      "/users — пользователи бота",
      "/user telegram_id — карточка пользователя",
      "/grant telegram_id START|PRO дни — выдать подписку",
      "/extend telegram_id дни — продлить подписку",
      "/revoke telegram_id — отменить подписку",
      "/blockuser telegram_id — отключить аккаунт",
      "/unblockuser telegram_id — включить аккаунт",
      "/id — показать chat_id",
      "/stats — статистика лидов",
      "/leads — активные заявки",
        "/work — заявки в работе",
      "/lead LeadID — открыть заявку",
      "/archive — архив заявок",
      "/trash — скрытые / удалённые заявки",
      "/restore LeadID — восстановить заявку",
      "/note LeadID текст — добавить заметку",
      "/banuser telegram_id причина — забанить пользователя",
      "/unbanuser telegram_id — разбанить пользователя",
      "/banlist — список забаненных",
      "/blackwords — чёрные слова",
      "/addblackword слово — добавить чёрное слово",
      "/removeblackword слово — удалить чёрное слово",
      "/chats — источники",
      "/blockchat chat_id — заблокировать источник",
      "/unblockchat chat_id — разблокировать источник"
    ].join("\n")
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(
    [
      `chat_id: ${ctx.chat.id}`,
      `chat_type: ${ctx.chat.type}`,
      ctx.from ? `user_id: ${ctx.from.id}` : null
    ]
      .filter(Boolean)
      .join("\n")
  );
});

bot.command("triggers", async (ctx) => {
  const user = await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.reply(
      "Сначала зарегистрируйтесь через /start."
    );
    return;
  }

  if (!user.isActive) {
    await ctx.reply(
      "Ваш аккаунт отключён. Обратитесь к администратору."
    );
    return;
  }

  if (!hasSubscriptionAccess(user)) {
    await ctx.reply(
      [
        "Ваша подписка неактивна или закончилась.",
        "",
        "Проверить подписку: /subscription",
        "Посмотреть тарифы: /plans"
      ].join("\n")
    );
    return;
  }

  await replyWithUserTriggers(ctx, user.id);
});

bot.command("addtrigger", async (ctx) => {
  const user = await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.reply(
      "Сначала зарегистрируйтесь через /start."
    );
    return;
  }

  if (!user.isActive) {
    await ctx.reply(
      "Ваш аккаунт отключён. Обратитесь к администратору."
    );
    return;
  }

  if (!hasSubscriptionAccess(user)) {
    await ctx.reply(
      [
        "Ваша подписка неактивна или закончилась.",
        "",
        "Проверить подписку: /subscription",
        "Посмотреть тарифы: /plans"
      ].join("\n")
    );
    return;
  }

  const phrase = (
    ctx.message?.text
      .replace(/^\/addtrigger(?:@\w+)?\s*/i, "")
      .trim() ?? ""
  );

  if (!phrase) {
    await ctx.reply(
      [
        "Укажите фразу после команды.",
        "",
        "Пример:",
        "/addtrigger нужен дизайнер"
      ].join("\n")
    );
    return;
  }

  if (phrase.length < 3) {
    await ctx.reply(
      "Триггер должен содержать минимум 3 символа."
    );
    return;
  }

  if (phrase.length > 100) {
    await ctx.reply(
      "Триггер не должен превышать 100 символов."
    );
    return;
  }

  const normalizedPhrase = normalizePlain(phrase);

  if (normalizedPhrase.length < 3) {
    await ctx.reply(
      "После нормализации триггер получился слишком коротким."
    );
    return;
  }

  const existingTrigger =
    await prisma.userTrigger.findUnique({
      where: {
        userId_normalizedPhrase: {
          userId: user.id,
          normalizedPhrase
        }
      },
      select: {
        id: true,
        isActive: true
      }
    });

  if (!existingTrigger?.isActive) {
    const triggerCount =
      await prisma.userTrigger.count({
        where: {
          userId: user.id,
          isActive: true
        }
      });

    const plan = getPlanDefinition(user);

    if (
      plan.maxTriggers !== null &&
      triggerCount >= plan.maxTriggers
    ) {
      await ctx.reply(
        [
          `Достигнут лимит тарифа ${plan.label}.`,
          "",
          `Активных триггеров: ${triggerCount} / ${plan.maxTriggers}`,
          "Другие тарифы: /plans"
        ].join("\n")
      );
      return;
    }
  }

  const trigger = await prisma.userTrigger.upsert({
    where: {
      userId_normalizedPhrase: {
        userId: user.id,
        normalizedPhrase
      }
    },
    update: {
      phrase,
      isActive: true
    },
    create: {
      userId: user.id,
      phrase,
      normalizedPhrase,
      isActive: true
    },
    select: {
      id: true,
      phrase: true
    }
  });

  console.log("USER_TRIGGER_ADDED", {
    userId: user.id,
    telegramId: user.telegramId,
    triggerId: trigger.id,
    phrase: trigger.phrase
  });

  await ctx.reply(
    `✅ Триггер добавлен: «${trigger.phrase}»`
  );

  await replyWithUserTriggers(ctx, user.id);
});

bot.command("removetrigger", async (ctx) => {
  const user = await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.reply(
      "Сначала зарегистрируйтесь через /start."
    );
    return;
  }

  if (!hasSubscriptionAccess(user)) {
    await ctx.reply(
      [
        "Ваша подписка неактивна или закончилась.",
        "",
        "Проверить подписку: /subscription",
        "Посмотреть тарифы: /plans"
      ].join("\n")
    );
    return;
  }

  const phrase = (
    ctx.message?.text
      .replace(/^\/removetrigger(?:@\w+)?\s*/i, "")
      .trim() ?? ""
  );

  if (!phrase) {
    await ctx.reply(
      [
        "Укажите точную фразу триггера.",
        "",
        "Пример:",
        "/removetrigger нужен дизайнер"
      ].join("\n")
    );
    return;
  }

  const normalizedPhrase = normalizePlain(phrase);

  const result = await prisma.userTrigger.deleteMany({
    where: {
      userId: user.id,
      normalizedPhrase
    }
  });

  if (!result.count) {
    await ctx.reply(
      "Такой триггер не найден."
    );
    return;
  }

  console.log("USER_TRIGGER_REMOVED", {
    userId: user.id,
    telegramId: user.telegramId,
    normalizedPhrase
  });

  await ctx.reply(
    `🗑 Триггер удалён: «${phrase}»`
  );

  await replyWithUserTriggers(ctx, user.id);
});

async function replyAndAutoDelete(
  ctx: Context,
  text: string,
  delayMs = 3000
): Promise<void> {
  const sentMessage = await ctx.reply(text);

  setTimeout(() => {
    void bot.api
      .deleteMessage(
        sentMessage.chat.id,
        sentMessage.message_id
      )
      .catch((error) => {
        console.error(
          "AUTO_DELETE_REPLY_ERROR",
          {
            chatId: sentMessage.chat.id,
            messageId: sentMessage.message_id,
            error
          }
        );
      });
  }, delayMs);
}

bot.command("connectchat", async (ctx) => {
  const chat = ctx.chat;
  const from = ctx.from;

  if (!chat || !from || chat.type === "private") {
    await ctx.reply(
      "Команду /connectchat нужно отправить в подключаемой группе."
    );
    return;
  }

  const user = await getRegisteredUserByTelegramId(
    String(from.id)
  );

  if (!user) {
    await ctx.reply(
      "Сначала откройте личный чат с ботом и выполните /start."
    );
    return;
  }

  if (!hasSubscriptionAccess(user)) {
    await ctx.reply(
      "Ваша подписка неактивна или пробный период закончился."
    );
    return;
  }

  const member = await ctx.api
    .getChatMember(chat.id, from.id)
    .catch(() => null);

  if (
    !member ||
    !["creator", "administrator"].includes(member.status)
  ) {
    await ctx.reply(
      "Подключить группу может только её администратор."
    );
    return;
  }

  await trackSourceChat(ctx);

  if (await isSourceChatBlocked(ctx)) {
    await ctx.reply(
      "Этот источник заблокирован владельцем бота."
    );
    return;
  }

  const existingConnection =
    await prisma.userSourceChat.findUnique({
      where: {
        userId_chatId: {
          userId: user.id,
          chatId: String(chat.id)
        }
      },
      select: {
        isActive: true
      }
    });

  if (!existingConnection?.isActive) {
    const activeSourceCount =
      await prisma.userSourceChat.count({
        where: {
          userId: user.id,
          isActive: true,
          sourceChat: {
            isBlocked: false
          }
        }
      });

    const plan = getPlanDefinition(user);

    if (
      plan.maxSources !== null &&
      activeSourceCount >= plan.maxSources
    ) {
      await ctx.reply(
        [
          `Достигнут лимит тарифа ${plan.label}.`,
          "",
          `Активных источников: ${activeSourceCount} / ${plan.maxSources}`,
          "Отключить источник: /disconnectchat",
          "Другие тарифы: /plans"
        ].join("\n")
      );
      return;
    }
  }

  await prisma.userSourceChat.upsert({
    where: {
      userId_chatId: {
        userId: user.id,
        chatId: String(chat.id)
      }
    },
    update: {
      isActive: true
    },
    create: {
      userId: user.id,
      chatId: String(chat.id),
      isActive: true
    }
  });

  await replyAndAutoDelete(
    ctx,
    [
      "✅ Группа подключена.",
      "",
      `Источник: ${getChatTitle(ctx)}`,
      `Chat ID: ${chat.id}`
    ].join("\n")
  );
});

bot.command("sources", async (ctx) => {
  const user = await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.reply(
      "Сначала зарегистрируйтесь через /start."
    );
    return;
  }

  const sources = await prisma.userSourceChat.findMany({
    where: {
      userId: user.id
    },
    orderBy: {
      updatedAt: "desc"
    },
    select: {
      chatId: true,
      isActive: true,
      sourceChat: {
        select: {
          title: true,
          isBlocked: true
        }
      }
    }
  });

  if (!sources.length) {
    await ctx.reply(
      [
        "📍 Подключённых источников пока нет.",
        "",
        "Добавьте бота в группу и отправьте там:",
        "/connectchat"
      ].join("\n")
    );
    return;
  }

  await ctx.reply(
    [
      "📍 <b>Мои источники</b>",
      "",
      ...sources.map((source, index) => {
        const status = source.sourceChat.isBlocked
          ? "🚫 заблокирован владельцем"
          : source.isActive
            ? "✅ подключён"
            : "⏸ отключён";

        return [
          `${index + 1}. <b>${escapeHtml(source.sourceChat.title)}</b>`,
          `ID: <code>${escapeHtml(source.chatId)}</code>`,
          `Статус: ${status}`
        ].join("\n");
      })
    ].join("\n\n"),
    {
      parse_mode: "HTML"
    }
  );
});

bot.command("disconnectchat", async (ctx) => {
  if (!ctx.from || !ctx.chat) return;

  const user = await getRegisteredUserByTelegramId(
    String(ctx.from.id)
  );

  if (!user) {
    await ctx.reply(
      "Сначала зарегистрируйтесь через /start."
    );
    return;
  }

  const argument =
    ctx.message?.text.trim().split(/\s+/)[1];

  const targetChatId =
    ctx.chat.type === "private"
      ? argument
      : String(ctx.chat.id);

  if (!targetChatId) {
    await ctx.reply(
      "Формат:\n/disconnectchat -1001234567890"
    );
    return;
  }

  const result = await prisma.userSourceChat.updateMany({
    where: {
      userId: user.id,
      chatId: targetChatId
    },
    data: {
      isActive: false
    }
  });

  if (!result.count) {
    await ctx.reply(
      "Источник не найден среди ваших подключений."
    );
    return;
  }

  await replyAndAutoDelete(
    ctx,
    `⏸ Источник отключён: ${targetChatId}`
  );
});


async function replyWithSubscriptionProfile(
  ctx: Context,
  title: string
): Promise<void> {
  const user = await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.reply(
      "Откройте личный чат с ботом и выполните /start."
    );
    return;
  }

  const [
    activeTriggerCount,
    activeSourceCount,
    deliveryCount
  ] = await Promise.all([
    prisma.userTrigger.count({
      where: {
        userId: user.id,
        isActive: true
      }
    }),
    prisma.userSourceChat.count({
      where: {
        userId: user.id,
        isActive: true,
        sourceChat: {
          isBlocked: false
        }
      }
    }),
    prisma.leadDelivery.count({
      where: {
        recipientUserId: user.id
      }
    })
  ]);

  const plan = getPlanDefinition(user);
  const hasAccess = hasSubscriptionAccess(user);

  const statusLabel =
    getEffectiveSubscriptionStatusLabel(
      user.subscription?.status ?? null,
      user.subscription?.expiresAt ?? null
    );

  const displayName = getBotUserDisplayName({
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    telegramId: user.telegramId
  });

  await ctx.reply(
    [
      `${title}`,
      "",
      `<b>${escapeHtml(displayName)}</b>`,
      `Telegram ID: <code>${escapeHtml(user.telegramId)}</code>`,
      `Роль: ${escapeHtml(getUserRoleLabel(user.role))}`,
      `Аккаунт: ${user.isActive ? "✅ активен" : "🚫 заблокирован"}`,
      "",
      "💳 <b>Подписка</b>",
      `Тариф: ${escapeHtml(plan.label)} (<code>${escapeHtml(plan.code)}</code>)`,
      `Статус: ${escapeHtml(statusLabel)}`,
      `Доступ: ${hasAccess ? "✅ разрешён" : "⛔ приостановлен"}`,
      `Начало: ${escapeHtml(
        formatAccessDate(
          user.subscription?.startsAt ?? null
        )
      )}`,
      `Окончание: ${escapeHtml(
        formatAccessDate(
          user.subscription?.expiresAt ?? null
        )
      )}`,
      `Автопродление: ${
        user.subscription?.autoRenew
          ? "включено"
          : "выключено"
      }`,
      "",
      "📊 <b>Использование</b>",
      `Триггеры: ${escapeHtml(
        formatPlanUsage(
          activeTriggerCount,
          plan.maxTriggers
        )
      )}`,
      `Активные источники: ${escapeHtml(
        formatPlanUsage(
          activeSourceCount,
          plan.maxSources
        )
      )}`,
      `Получено лидов: ${deliveryCount}`,
      "",
      hasAccess
        ? "Бот готов принимать персональные лиды."
        : "Для восстановления доступа обратитесь к владельцу бота."
    ].join("\n"),
    {
      parse_mode: "HTML"
    }
  );
}

bot.command("profile", async (ctx) => {
  await replyWithSubscriptionProfile(
    ctx,
    "👤 <b>Мой профиль</b>"
  );
});

bot.command("subscription", async (ctx) => {
  await replyWithSubscriptionProfile(
    ctx,
    "💳 <b>Моя подписка</b>"
  );
});

async function replyWithPaymentMethods(
  ctx: Context,
  planCode: PaidPlanCode
): Promise<void> {
  const plan =
    PLAN_DEFINITIONS[planCode];

  const offer =
    PAYMENT_OFFERS[planCode];

  await ctx.reply(
    [
      `💳 <b>Оплата тарифа ${escapeHtml(plan.label)}</b>`,
      "",
      `Срок: ${offer.durationDays} дн.`,
      `Триггеры: ${formatPlanLimit(plan.maxTriggers)}`,
      `Источники: ${formatPlanLimit(plan.maxSources)}`,
      "",
      "Выберите способ оплаты:",
      "",
      `⭐ Telegram Stars: ${escapeHtml(
        formatStarsPrice(
          offer.starsAmount
        )
      )}`,
      `💳 ЮKassa: ${escapeHtml(
        formatRubPrice(
          offer.rubAmountMinor
        )
      )} — скоро`,
      `💳 Robokassa: ${escapeHtml(
        formatRubPrice(
          offer.rubAmountMinor
        )
      )} — скоро`,
      "",
      `Счёт действителен: ${paymentOrderTtlMinutes} мин.`,
      "Подписка будет активирована только после подтверждения платежа.",
      "",
      "Оплачивая тариф, вы принимаете условия: /terms"
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup:
        buildPaymentProviderKeyboard(
          planCode
        )
    }
  );
}

async function replyWithPlans(
  ctx: Context
): Promise<void> {
  const trial = PLAN_DEFINITIONS.TRIAL;
  const start = PLAN_DEFINITIONS.START;
  const pro = PLAN_DEFINITIONS.PRO;

  const startOffer =
    PAYMENT_OFFERS.START;

  const proOffer =
    PAYMENT_OFFERS.PRO;

  await ctx.reply(
    [
      "💳 <b>Тарифы бота</b>",
      "",
      `🧪 <b>${escapeHtml(trial.label)}</b>`,
      `Срок: ${trialDays} дней`,
      `Триггеры: ${formatPlanLimit(trial.maxTriggers)}`,
      `Источники: ${formatPlanLimit(trial.maxSources)}`,
      "",
      `🚀 <b>${escapeHtml(start.label)}</b>`,
      `Срок: ${startOffer.durationDays} дней`,
      `Цена: ${escapeHtml(
        formatPaymentOfferPrices(
          startOffer
        )
      )}`,
      `Триггеры: ${formatPlanLimit(start.maxTriggers)}`,
      `Источники: ${formatPlanLimit(start.maxSources)}`,
      "",
      `💼 <b>${escapeHtml(pro.label)}</b>`,
      `Срок: ${proOffer.durationDays} дней`,
      `Цена: ${escapeHtml(
        formatPaymentOfferPrices(
          proOffer
        )
      )}`,
      `Триггеры: ${formatPlanLimit(pro.maxTriggers)}`,
      `Источники: ${formatPlanLimit(pro.maxSources)}`,
      "",
      "Во всех тарифах доступны:",
      "• персональные триггеры;",
      "• уведомления о новых заявках;",
      "• статусы и работа с лидами;",
      "• архив, корзина и заметки;",
      "",
      "Выберите тариф для продолжения."
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup:
        buildPlansKeyboard()
    }
  );
}

bot.command("plans", async (ctx) => {
  await replyWithPlans(ctx);
});

bot.command("paysupport", async (ctx) => {
  const telegramId =
    ctx.from?.id
      ? String(ctx.from.id)
      : "не определён";

  await ctx.reply(
    [
      "🛟 <b>Поддержка по оплате</b>",
      "",
      "По вопросам оплаты и активации подписки напишите владельцу:",
      "@rilfok",
      "",
      `Ваш Telegram ID: <code>${escapeHtml(
        telegramId
      )}</code>`,
      "",
      "При обращении укажите:",
      "• Telegram ID;",
      "• выбранный тариф;",
      "• способ оплаты;",
      "• ID заказа из сообщения бота;",
      "",
      "Поддержка Telegram не обрабатывает споры по покупкам, совершённым внутри этого бота."
    ].join("\n"),
    {
      parse_mode: "HTML"
    }
  );
});

bot.command("terms", async (ctx) => {
  await ctx.reply(
    [
      "📄 <b>Условия использования и оплаты</b>",
      "",
      "1. Предмет услуги",
      "Оплата предоставляет доступ к функциям Telegram-бота мониторинга заявок и персональных триггеров.",
      "",
      "2. Тариф и срок",
      `Платный доступ предоставляется на ${paymentDurationDays} дней. Лимиты тарифов указаны в разделе /plans.`,
      "",
      "3. Активация",
      "Подписка активируется только после подтверждения успешной оплаты платёжным провайдером.",
      "",
      "4. Работа сервиса",
      "Бот автоматизирует поиск и обработку сообщений, но не гарантирует количество заявок, их качество или заключение сделок.",
      "",
      "5. Ответственность пользователя",
      "Пользователь самостоятельно отвечает за законность подключения источников, обработку информации и общение с потенциальными клиентами.",
      "",
      "6. Ошибки оплаты и возвраты",
      "При ошибке оплаты или активации обратитесь через /paysupport. Обращение рассматривается с учётом фактического предоставления доступа и правил выбранного платёжного провайдера.",
      "",
      "7. Данные",
      "Бот хранит Telegram ID, настройки, историю заявок и технические идентификаторы платежей. Банковские реквизиты бот не сохраняет.",
      "",
      "8. Изменение условий",
      "Изменения цен и условий применяются к новым покупкам. Уже оплаченный период сохраняется до даты окончания.",
      "",
      "Поддержка: @rilfok",
      "",
      "Оплата означает принятие этих условий."
    ].join("\n"),
    {
      parse_mode: "HTML"
    }
  );
});

function parseSubscriptionDays(
  rawValue: string | undefined
): number | null {
  if (!rawValue || !/^\d+$/.test(rawValue)) {
    return null;
  }

  const days = Number(rawValue);

  if (
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > 3650
  ) {
    return null;
  }

  return days;
}

type PaidPlanCode =
  | "START"
  | "PRO";

function parsePaidPlanCode(
  rawValue: string | undefined
): PaidPlanCode | null {
  const planCode =
    rawValue?.trim().toUpperCase();

  if (
    planCode === "START" ||
    planCode === "PRO"
  ) {
    return planCode;
  }

  return null;
}

async function createPaymentRecord(
  userId: string,
  provider: PaymentProvider,
  planCode: PaidPlanCode
) {
  const offer =
    PAYMENT_OFFERS[planCode];

  const configuredAmount =
    getConfiguredPaymentAmount(
      provider,
      offer
    );

  if (!configuredAmount) {
    return null;
  }

  return prisma.payment.create({
    data: {
      userId,
      provider,
      status: PaymentStatus.CREATED,
      planCode,
      durationDays:
        offer.durationDays,
      amountMinor:
        configuredAmount.amountMinor,
      currency:
        configuredAmount.currency,
      idempotencyKey:
        randomUUID(),
      expiresAt: new Date(
        Date.now() +
        paymentOrderTtlMs
      ),
      metadata: {
        source: "telegram_bot"
      }
    }
  });
}

function buildTelegramStarsInvoicePayload(
  paymentId: string
): string {
  return `payment:${paymentId}`;
}

function parseTelegramStarsInvoicePayload(
  payload: string
): string | null {
  const prefix = "payment:";

  if (!payload.startsWith(prefix)) {
    return null;
  }

  const paymentId =
    payload.slice(prefix.length).trim();

  return paymentId || null;
}

async function sendTelegramStarsInvoice(
  ctx: Context,
  payment: {
    id: string;
    amountMinor: number;
    durationDays: number;
  },
  planCode: PaidPlanCode
): Promise<void> {
  if (
    !ctx.chat ||
    ctx.chat.type !== "private"
  ) {
    throw new Error(
      "Оплата Telegram Stars доступна только в личном чате"
    );
  }

  const plan =
    PLAN_DEFINITIONS[planCode];

  await ctx.replyWithInvoice(
    `${plan.label} — ${payment.durationDays} дней`,
    [
      `${payment.durationDays} дней доступа к боту.`,
      `До ${formatPlanLimit(
        plan.maxTriggers
      )} триггеров и до ${formatPlanLimit(
        plan.maxSources
      )} источников.`
    ].join(" "),
    buildTelegramStarsInvoicePayload(
      payment.id
    ),
    "XTR",
    [
      {
        label: `Тариф ${plan.label}`,
        amount: payment.amountMinor
      }
    ],
    {
      provider_token: "",
      start_parameter:
        `payment_${payment.id}`,
      protect_content: true
    }
  );

  await prisma.payment.updateMany({
    where: {
      id: payment.id,
      status: PaymentStatus.CREATED,
      activatedAt: null
    },
    data: {
      status: PaymentStatus.PENDING
    }
  });
}

type PaymentActivationResult = {
  paymentId: string;
  userId: string;
  deliveryChatId: string | null;
  planCode: PaidPlanCode;
  expiresAt: Date;
  alreadyActivated: boolean;
};

async function activateSubscriptionFromPayment(
  paymentId: string,
  providerPaymentId: string
): Promise<PaymentActivationResult> {
  const result =
    await prisma.$transaction(
      async (tx) => {
        const payment =
          await tx.payment.findUnique({
            where: {
              id: paymentId
            },
            include: {
              user: {
                select: {
                  id: true,
                  telegramId: true,
                  deliveryChatId: true,
                  role: true,
                  subscription: {
                    select: {
                      expiresAt: true
                    }
                  }
                }
              }
            }
          });

        if (!payment) {
          throw new Error(
            `Платёж не найден: ${paymentId}`
          );
        }

        if (
          payment.user.role ===
          UserRole.OWNER
        ) {
          throw new Error(
            "Владельцу не требуется платная подписка"
          );
        }

        const planCode =
          parsePaidPlanCode(
            payment.planCode
          );

        if (!planCode) {
          throw new Error(
            `Некорректный тариф платежа: ${payment.planCode}`
          );
        }

        if (payment.activatedAt) {
          const currentExpiresAt =
            payment.user.subscription
              ?.expiresAt;

          if (!currentExpiresAt) {
            throw new Error(
              "Платёж отмечен активированным, но срок подписки отсутствует"
            );
          }

          return {
            paymentId: payment.id,
            userId: payment.user.id,
            deliveryChatId:
              payment.user.deliveryChatId,
            planCode,
            expiresAt:
              currentExpiresAt,
            alreadyActivated: true
          };
        }

        const now = new Date();

        const claim =
          await tx.payment.updateMany({
            where: {
              id: payment.id,
              activatedAt: null,
              status: {
                in: [
                  PaymentStatus.CREATED,
                  PaymentStatus.PENDING,
                  PaymentStatus.SUCCEEDED,
                  PaymentStatus.EXPIRED
                ]
              }
            },
            data: {
              status:
                PaymentStatus.SUCCEEDED,
              providerPaymentId,
              paidAt:
                payment.paidAt ?? now,
              activatedAt: now,
              failureReason: null
            }
          });

        if (claim.count === 0) {
          const currentPayment =
            await tx.payment.findUnique({
              where: {
                id: payment.id
              },
              include: {
                user: {
                  select: {
                    id: true,
                    deliveryChatId: true,
                    subscription: {
                      select: {
                        expiresAt: true
                      }
                    }
                  }
                }
              }
            });

          const currentExpiresAt =
            currentPayment?.user
              .subscription?.expiresAt;

          if (
            !currentPayment?.activatedAt ||
            !currentExpiresAt
          ) {
            throw new Error(
              "Платёж не может быть активирован в текущем статусе"
            );
          }

          return {
            paymentId:
              currentPayment.id,
            userId:
              currentPayment.user.id,
            deliveryChatId:
              currentPayment.user
                .deliveryChatId,
            planCode,
            expiresAt:
              currentExpiresAt,
            alreadyActivated: true
          };
        }

        const currentExpiresAt =
          payment.user.subscription
            ?.expiresAt;

        const extensionBase =
          currentExpiresAt &&
          currentExpiresAt.getTime() >
            now.getTime()
            ? currentExpiresAt
            : now;

        const expiresAt =
          addDaysToDate(
            extensionBase,
            payment.durationDays
          );

        await tx.subscription.upsert({
          where: {
            userId: payment.user.id
          },
          update: {
            planCode,
            status:
              SubscriptionStatus.ACTIVE,
            startsAt: now,
            expiresAt,
            autoRenew: false
          },
          create: {
            userId: payment.user.id,
            planCode,
            status:
              SubscriptionStatus.ACTIVE,
            startsAt: now,
            expiresAt,
            autoRenew: false
          }
        });

        return {
          paymentId: payment.id,
          userId: payment.user.id,
          deliveryChatId:
            payment.user.deliveryChatId,
          planCode,
          expiresAt,
          alreadyActivated: false
        };
      }
    );

  if (!result.alreadyActivated) {
    const plan =
      PLAN_DEFINITIONS[
        result.planCode
      ];

    await enforceUserPlanLimits(
      result.userId,
      plan
    );

    await notifyBotUser(
      result.deliveryChatId,
      [
        "✅ Оплата подтверждена.",
        "",
        `Тариф: ${plan.label}`,
        `Доступ до: ${formatAccessDate(
          result.expiresAt
        )}`,
        "",
        "Подписка активирована.",
        "Проверить: /subscription"
      ].join("\n")
    );
  }

  return result;
}

function addDaysToDate(
  date: Date,
  days: number
): Date {
  return new Date(
    date.getTime() + days * 24 * 60 * 60 * 1000
  );
}

function getUserRoleLabel(role: UserRole): string {
  return role === UserRole.OWNER
    ? "Владелец"
    : "Пользователь";
}

function getSubscriptionStatusLabel(
  status: SubscriptionStatus | null
): string {
  switch (status) {
    case SubscriptionStatus.TRIAL:
      return "Пробный период";
    case SubscriptionStatus.ACTIVE:
      return "Активна";
    case SubscriptionStatus.PAST_DUE:
      return "Просрочена";
    case SubscriptionStatus.CANCELED:
      return "Отменена";
    case SubscriptionStatus.EXPIRED:
      return "Истекла";
    default:
      return "Не оформлена";
  }
}

function getEffectiveSubscriptionStatusLabel(
  status: SubscriptionStatus | null,
  expiresAt: Date | null
): string {
  if (
    expiresAt &&
    expiresAt.getTime() <= Date.now() &&
    (
      status === SubscriptionStatus.TRIAL ||
      status === SubscriptionStatus.ACTIVE
    )
  ) {
    return "Истекла";
  }

  return getSubscriptionStatusLabel(status);
}

function getBotUserDisplayName(user: {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  telegramId: string;
}): string {
  const name = [
    user.firstName,
    user.lastName
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (user.username) {
    return name
      ? `${name} / @${user.username}`
      : `@${user.username}`;
  }

  return name || user.telegramId;
}

async function getManagedBotUser(
  telegramId: string
) {
  return prisma.botUser.findUnique({
    where: {
      telegramId
    },
    select: {
      id: true,
      telegramId: true,
      username: true,
      firstName: true,
      lastName: true,
      role: true,
      isActive: true,
      deliveryChatId: true,
      createdAt: true,
      updatedAt: true,
      subscription: {
        select: {
          planCode: true,
          status: true,
          startsAt: true,
          expiresAt: true,
          autoRenew: true
        }
      },
      _count: {
        select: {
          triggers: true,
          sourceChats: true,
          deliveries: true
        }
      }
    }
  });
}

function formatManagedBotUser(
  user: NonNullable<
    Awaited<ReturnType<typeof getManagedBotUser>>
  >
): string {
  const subscription = user.subscription;

  return [
    "👤 <b>Карточка пользователя</b>",
    "",
    `<b>${escapeHtml(getBotUserDisplayName(user))}</b>`,
    `Telegram ID: <code>${escapeHtml(user.telegramId)}</code>`,
    `Роль: ${escapeHtml(getUserRoleLabel(user.role))}`,
    `Аккаунт: ${user.isActive ? "✅ активен" : "🚫 заблокирован"}`,
    `Чат доставки: <code>${escapeHtml(user.deliveryChatId ?? "не задан")}</code>`,
    "",
    "💳 <b>Подписка</b>",
    `Тариф: ${escapeHtml(subscription?.planCode ?? "—")}`,
    `Статус: ${escapeHtml(
      getEffectiveSubscriptionStatusLabel(
        subscription?.status ?? null,
        subscription?.expiresAt ?? null
      )
    )}`,
    `Начало: ${escapeHtml(
      formatAccessDate(
        subscription?.startsAt ?? null
      )
    )}`,
    `Окончание: ${escapeHtml(
      formatAccessDate(
        subscription?.expiresAt ?? null
      )
    )}`,
    `Автопродление: ${
      subscription?.autoRenew
        ? "включено"
        : "выключено"
    }`,
    "",
    "📊 <b>Использование</b>",
    `Триггеров: ${user._count.triggers}`,
    `Источников: ${user._count.sourceChats}`,
    `Доставок лидов: ${user._count.deliveries}`,
    "",
    `Регистрация: ${escapeHtml(
      formatAccessDate(user.createdAt)
    )}`
  ].join("\n");
}

async function notifyBotUser(
  deliveryChatId: string | null,
  text: string
): Promise<void> {
  if (!deliveryChatId) return;

  await bot.api
    .sendMessage(deliveryChatId, text)
    .catch((error) => {
      console.error("BOT_USER_NOTIFICATION_ERROR", {
        deliveryChatId,
        error
      });
    });
}

bot.command("users", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const users = await prisma.botUser.findMany({
    orderBy: {
      createdAt: "desc"
    },
    take: 30,
    select: {
      telegramId: true,
      username: true,
      firstName: true,
      lastName: true,
      role: true,
      isActive: true,
      subscription: {
        select: {
          planCode: true,
          status: true,
          expiresAt: true
        }
      },
      _count: {
        select: {
          triggers: true,
          sourceChats: true
        }
      }
    }
  });

  if (!users.length) {
    await ctx.reply(
      "Зарегистрированных пользователей пока нет."
    );
    return;
  }

  const items = users.map((user, index) => {
    const subscription = user.subscription;

    return [
      `${index + 1}. <b>${escapeHtml(
        getBotUserDisplayName(user)
      )}</b>`,
      `ID: <code>${escapeHtml(user.telegramId)}</code>`,
      `Роль: ${escapeHtml(
        getUserRoleLabel(user.role)
      )}`,
      `Аккаунт: ${user.isActive ? "✅" : "🚫"}`,
      `Подписка: ${escapeHtml(
        subscription?.planCode ?? "—"
      )} / ${escapeHtml(
        getEffectiveSubscriptionStatusLabel(
        subscription?.status ?? null,
        subscription?.expiresAt ?? null
      )
      )}`,
      `До: ${escapeHtml(
        formatAccessDate(
          subscription?.expiresAt ?? null
        )
      )}`,
      `Триггеры: ${user._count.triggers} | Источники: ${user._count.sourceChats}`
    ].join("\n");
  });

  await ctx.reply(
    [
      "👥 <b>Пользователи бота</b>",
      "",
      ...items,
      "",
      "Подробная карточка:",
      "<code>/user telegram_id</code>"
    ].join("\n\n"),
    {
      parse_mode: "HTML"
    }
  );
});

bot.command("user", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const telegramId =
    ctx.message?.text.trim().split(/\s+/)[1];

  if (!telegramId) {
    await ctx.reply(
      "Формат:\n/user 123456789"
    );
    return;
  }

  const user = await getManagedBotUser(telegramId);

  if (!user) {
    await ctx.reply("Пользователь не найден.");
    return;
  }

  await ctx.reply(
    formatManagedBotUser(user),
    {
      parse_mode: "HTML"
    }
  );
});

bot.command("grant", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const parts =
    (ctx.message?.text ?? "")
      .trim()
      .split(/\s+/);

  const telegramId = parts[1];
  const rawPlanOrDays = parts[2];
  const explicitPlan =
    parsePaidPlanCode(rawPlanOrDays);

  const planCode: PaidPlanCode =
    explicitPlan ?? "START";

  const rawDays =
    explicitPlan
      ? parts[3]
      : rawPlanOrDays;

  const days =
    parseSubscriptionDays(rawDays);

  if (!telegramId || !days) {
    await ctx.reply(
      [
        "Формат:",
        "/grant telegram_id тариф количество_дней",
        "",
        "Доступные тарифы:",
        "START",
        "PRO",
        "",
        "Примеры:",
        "/grant 123456789 START 30",
        "/grant 123456789 PRO 30",
        "",
        "Старый формат тоже поддерживается:",
        "/grant 123456789 30",
        "В этом случае будет выдан тариф START.",
        "",
        "Допустимый срок: от 1 до 3650 дней."
      ].join("\n")
    );
    return;
  }

  const user =
    await getManagedBotUser(telegramId);

  if (!user) {
    await ctx.reply(
      "Пользователь не найден."
    );
    return;
  }

  if (user.role === UserRole.OWNER) {
    await ctx.reply(
      "Подписка владельца бессрочная и не изменяется."
    );
    return;
  }

  const now = new Date();
  const expiresAt =
    addDaysToDate(now, days);

  const plan =
    PLAN_DEFINITIONS[planCode];

  await prisma.subscription.upsert({
    where: {
      userId: user.id
    },
    update: {
      planCode,
      status: SubscriptionStatus.ACTIVE,
      startsAt: now,
      expiresAt,
      autoRenew: false
    },
    create: {
      userId: user.id,
      planCode,
      status: SubscriptionStatus.ACTIVE,
      startsAt: now,
      expiresAt,
      autoRenew: false
    }
  });

  const enforcedLimits =
    await enforceUserPlanLimits(
      user.id,
      plan
    );

  await ctx.reply(
    [
      "✅ Подписка выдана.",
      "",
      `Пользователь: ${getBotUserDisplayName(user)}`,
      `Telegram ID: ${user.telegramId}`,
      `Тариф: ${plan.label} (${plan.code})`,
      `Срок: ${days} дн.`,
      `Доступ до: ${formatAccessDate(expiresAt)}`,
      "",
      `Лимит триггеров: ${formatPlanLimit(plan.maxTriggers)}`,
      `Лимит источников: ${formatPlanLimit(plan.maxSources)}`,
      ...(
        enforcedLimits.disabledTriggerCount > 0 ||
        enforcedLimits.disabledSourceCount > 0
          ? [
              "",
              "⚠️ Превышение лимитов тарифа:",
              `Отключено триггеров: ${enforcedLimits.disabledTriggerCount}`,
              `Отключено источников: ${enforcedLimits.disabledSourceCount}`
            ]
          : []
      )
    ].join("\n")
  );

  await notifyBotUser(
    user.deliveryChatId,
    [
      "✅ Ваша подписка активирована.",
      "",
      `Тариф: ${plan.label}`,
      `Срок: ${days} дн.`,
      `Доступ до: ${formatAccessDate(expiresAt)}`,
      "",
      `Триггеры: до ${formatPlanLimit(plan.maxTriggers)}`,
      `Источники: до ${formatPlanLimit(plan.maxSources)}`,
      ...(
        enforcedLimits.disabledTriggerCount > 0 ||
        enforcedLimits.disabledSourceCount > 0
          ? [
              "",
              "Часть ресурсов отключена из-за лимитов тарифа.",
              `Отключено триггеров: ${enforcedLimits.disabledTriggerCount}`,
              `Отключено источников: ${enforcedLimits.disabledSourceCount}`
            ]
          : []
      ),
      "",
      "Проверить подписку: /subscription"
    ].join("\n")
  );
});

bot.command("extend", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const [, telegramId, rawDays] =
    (ctx.message?.text ?? "")
      .trim()
      .split(/\s+/);

  const days =
    parseSubscriptionDays(rawDays);

  if (!telegramId || !days) {
    await ctx.reply(
      [
        "Формат:",
        "/extend telegram_id количество_дней",
        "",
        "Пример:",
        "/extend 123456789 7",
        "",
        "Текущий тариф пользователя будет сохранён."
      ].join("\n")
    );
    return;
  }

  const user =
    await getManagedBotUser(telegramId);

  if (!user) {
    await ctx.reply(
      "Пользователь не найден."
    );
    return;
  }

  if (user.role === UserRole.OWNER) {
    await ctx.reply(
      "Подписка владельца бессрочная и не изменяется."
    );
    return;
  }

  const now = new Date();

  const currentExpiresAt =
    user.subscription?.expiresAt;

  const extensionBase =
    currentExpiresAt &&
    currentExpiresAt.getTime() > now.getTime()
      ? currentExpiresAt
      : now;

  const expiresAt =
    addDaysToDate(extensionBase, days);

  await prisma.subscription.upsert({
    where: {
      userId: user.id
    },
    update: {
      status: SubscriptionStatus.ACTIVE,
      expiresAt,
      autoRenew: false
    },
    create: {
      userId: user.id,
      planCode: "START",
      status: SubscriptionStatus.ACTIVE,
      startsAt: now,
      expiresAt,
      autoRenew: false
    }
  });

  const plan =
    user.subscription
      ? getPlanDefinition(user)
      : PLAN_DEFINITIONS.START;

  const enforcedLimits =
    await enforceUserPlanLimits(
      user.id,
      plan
    );

  await ctx.reply(
    [
      "✅ Подписка продлена.",
      "",
      `Пользователь: ${getBotUserDisplayName(user)}`,
      `Telegram ID: ${user.telegramId}`,
      `Тариф: ${plan.label} (${plan.code})`,
      `Добавлено: ${days} дн.`,
      `Доступ до: ${formatAccessDate(expiresAt)}`,
      ...(
        enforcedLimits.disabledTriggerCount > 0 ||
        enforcedLimits.disabledSourceCount > 0
          ? [
              "",
              "⚠️ Приведение к лимитам:",
              `Отключено триггеров: ${enforcedLimits.disabledTriggerCount}`,
              `Отключено источников: ${enforcedLimits.disabledSourceCount}`
            ]
          : []
      )
    ].join("\n")
  );

  await notifyBotUser(
    user.deliveryChatId,
    [
      "✅ Ваша подписка продлена.",
      "",
      `Тариф: ${plan.label}`,
      `Добавлено: ${days} дн.`,
      `Доступ до: ${formatAccessDate(expiresAt)}`,
      "",
      "Проверить подписку: /subscription"
    ].join("\n")
  );
});

bot.command("revoke", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const telegramId =
    ctx.message?.text.trim().split(/\s+/)[1];

  if (!telegramId) {
    await ctx.reply(
      "Формат:\n/revoke 123456789"
    );
    return;
  }

  const user = await getManagedBotUser(telegramId);

  if (!user) {
    await ctx.reply("Пользователь не найден.");
    return;
  }

  if (user.role === UserRole.OWNER) {
    await ctx.reply(
      "Нельзя отозвать подписку владельца."
    );
    return;
  }

  if (!user.subscription) {
    await ctx.reply(
      "У пользователя нет подписки."
    );
    return;
  }

  await prisma.subscription.update({
    where: {
      userId: user.id
    },
    data: {
      status: SubscriptionStatus.CANCELED,
      expiresAt: new Date(),
      autoRenew: false
    }
  });

  await ctx.reply(
    `⛔ Подписка отменена: ${
      getBotUserDisplayName(user)
    }`
  );

  await notifyBotUser(
    user.deliveryChatId,
    "⛔ Ваша подписка отключена администратором."
  );
});

bot.command("blockuser", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const telegramId =
    ctx.message?.text.trim().split(/\s+/)[1];

  if (!telegramId) {
    await ctx.reply(
      "Формат:\n/blockuser 123456789"
    );
    return;
  }

  const user = await getManagedBotUser(telegramId);

  if (!user) {
    await ctx.reply("Пользователь не найден.");
    return;
  }

  if (user.role === UserRole.OWNER) {
    await ctx.reply(
      "Нельзя заблокировать владельца."
    );
    return;
  }

  await prisma.botUser.update({
    where: {
      id: user.id
    },
    data: {
      isActive: false
    }
  });

  await ctx.reply(
    `🚫 Аккаунт отключён: ${
      getBotUserDisplayName(user)
    }`
  );

  await notifyBotUser(
    user.deliveryChatId,
    "🚫 Ваш аккаунт отключён администратором."
  );
});

bot.command("unblockuser", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const telegramId =
    ctx.message?.text.trim().split(/\s+/)[1];

  if (!telegramId) {
    await ctx.reply(
      "Формат:\n/unblockuser 123456789"
    );
    return;
  }

  const user = await getManagedBotUser(telegramId);

  if (!user) {
    await ctx.reply("Пользователь не найден.");
    return;
  }

  await prisma.botUser.update({
    where: {
      id: user.id
    },
    data: {
      isActive: true
    }
  });

  await ctx.reply(
    `✅ Аккаунт включён: ${
      getBotUserDisplayName(user)
    }`
  );

  await notifyBotUser(
    user.deliveryChatId,
    "✅ Ваш аккаунт снова активен."
  );
});

bot.command("stats", async (ctx, next) => {
  if (assertAdmin(ctx)) {
    await next();
    return;
  }

  const user =
    await requirePersonalBotUser(ctx);

  if (!user) return;

  const baseWhere = {
    recipientUserId: user.id,
    deliveryType:
      LeadDeliveryType.USER_TRIGGER
  };

  const [
    total,
    fresh,
    contacted,
    waiting,
    progress,
    won,
    lost,
    ignored,
    deleted
  ] = await Promise.all([
    prisma.leadDelivery.count({
      where: baseWhere
    }),
    prisma.leadDelivery.count({
      where: {
        ...baseWhere,
        status: LeadStatus.NEW
      }
    }),
    prisma.leadDelivery.count({
      where: {
        ...baseWhere,
        status: LeadStatus.CONTACTED
      }
    }),
    prisma.leadDelivery.count({
      where: {
        ...baseWhere,
        status:
          LeadStatus.WAITING_REPLY
      }
    }),
    prisma.leadDelivery.count({
      where: {
        ...baseWhere,
        status:
          LeadStatus.IN_PROGRESS
      }
    }),
    prisma.leadDelivery.count({
      where: {
        ...baseWhere,
        status: LeadStatus.WON
      }
    }),
    prisma.leadDelivery.count({
      where: {
        ...baseWhere,
        status: LeadStatus.LOST
      }
    }),
    prisma.leadDelivery.count({
      where: {
        ...baseWhere,
        status: LeadStatus.IGNORED
      }
    }),
    prisma.leadDelivery.count({
      where: {
        ...baseWhere,
        status: LeadStatus.DELETED
      }
    })
  ]);

  await ctx.reply(
    [
      "📊 Личная статистика",
      "",
      `Всего: ${total}`,
      `Горячие / новые: ${fresh}`,
      `Связался: ${contacted}`,
      `Ждём ответ: ${waiting}`,
      `В обсуждении: ${progress}`,
      `В работе: ${won}`,
      `Отказ: ${lost}`,
      `Архив: ${ignored}`,
      `Удалённые: ${deleted}`
    ].join("\n")
  );
});

bot.command("leads", async (ctx, next) => {
  if (assertAdmin(ctx)) {
    await next();
    return;
  }

  const user =
    await requirePersonalBotUser(ctx);

  if (!user) return;

  const deliveries =
    await prisma.leadDelivery.findMany({
      where: {
        recipientUserId: user.id,
        deliveryType:
          LeadDeliveryType.USER_TRIGGER,
        status: {
          in: [
            LeadStatus.NEW,
            LeadStatus.CONTACTED,
            LeadStatus.WAITING_REPLY,
            LeadStatus.IN_PROGRESS
          ]
        }
      },
      orderBy: {
        updatedAt: "desc"
      },
      take: 10,
      select:
        personalLeadDeliverySelect
    });

  await ctx.reply(
    formatPersonalLeadList(
      "🔥 <b>Мои активные заявки</b>",
      deliveries
    ),
    {
      parse_mode: "HTML",
      reply_markup:
        buildPersonalLeadListKeyboard(
          deliveries
        ),
      link_preview_options: {
        is_disabled: true
      }
    }
  );
});

bot.command("work", async (ctx, next) => {
  if (assertAdmin(ctx)) {
    await next();
    return;
  }

  const user =
    await requirePersonalBotUser(ctx);

  if (!user) return;

  const deliveries =
    await prisma.leadDelivery.findMany({
      where: {
        recipientUserId: user.id,
        deliveryType:
          LeadDeliveryType.USER_TRIGGER,
        status: LeadStatus.WON
      },
      orderBy: {
        updatedAt: "desc"
      },
      take: 10,
      select:
        personalLeadDeliverySelect
    });

  await ctx.reply(
    formatPersonalLeadList(
      "🏆 <b>Мои заявки в работе</b>",
      deliveries
    ),
    {
      parse_mode: "HTML",
      reply_markup:
        buildPersonalLeadListKeyboard(
          deliveries
        ),
      link_preview_options: {
        is_disabled: true
      }
    }
  );
});

bot.command("lead", async (ctx, next) => {
  if (assertAdmin(ctx)) {
    await next();
    return;
  }

  const user =
    await requirePersonalBotUser(ctx);

  if (!user) return;

  const requestedId =
    ctx.message?.text
      .trim()
      .split(/\s+/)[1];

  if (!requestedId) {
    await ctx.reply(
      "Укажите Lead ID.\n\nПример:\n/lead e7mpkltd"
    );
    return;
  }

  const delivery =
    await getPersonalDeliveryByLeadId(
      user.id,
      requestedId
    );

  if (!delivery) {
    await ctx.reply(
      "Заявка не найдена среди ваших лидов."
    );
    return;
  }

  await ctx.reply(
    formatPersonalLeadNotification(
      delivery
    ),
    getPersonalLeadSendOptions(delivery)
  );
});

bot.command("archive", async (ctx, next) => {
  if (assertAdmin(ctx)) {
    await next();
    return;
  }

  const user =
    await requirePersonalBotUser(ctx);

  if (!user) return;

  const deliveries =
    await prisma.leadDelivery.findMany({
      where: {
        recipientUserId: user.id,
        deliveryType:
          LeadDeliveryType.USER_TRIGGER,
        status: LeadStatus.IGNORED
      },
      orderBy: {
        updatedAt: "desc"
      },
      take: 10,
      select:
        personalLeadDeliverySelect
    });

  await ctx.reply(
    formatPersonalLeadList(
      "🗄 <b>Мой архив</b>",
      deliveries
    ),
    {
      parse_mode: "HTML",
      reply_markup:
        buildPersonalArchiveKeyboard(
          deliveries
        ),
      link_preview_options: {
        is_disabled: true
      }
    }
  );
});

bot.command("trash", async (ctx, next) => {
  if (assertAdmin(ctx)) {
    await next();
    return;
  }

  const user =
    await requirePersonalBotUser(ctx);

  if (!user) return;

  const deliveries =
    await prisma.leadDelivery.findMany({
      where: {
        recipientUserId: user.id,
        deliveryType:
          LeadDeliveryType.USER_TRIGGER,
        status: LeadStatus.DELETED
      },
      orderBy: {
        updatedAt: "desc"
      },
      take: 10,
      select:
        personalLeadDeliverySelect
    });

  await ctx.reply(
    formatPersonalLeadList(
      "🗑 <b>Мои удалённые заявки</b>",
      deliveries
    ),
    {
      parse_mode: "HTML",
      reply_markup:
        buildPersonalLeadListKeyboard(
          deliveries
        ),
      link_preview_options: {
        is_disabled: true
      }
    }
  );
});

bot.command("restore", async (ctx, next) => {
  if (assertAdmin(ctx)) {
    await next();
    return;
  }

  const user =
    await requirePersonalBotUser(ctx);

  if (!user) return;

  const requestedId =
    ctx.message?.text
      .trim()
      .split(/\s+/)[1];

  if (!requestedId) {
    await ctx.reply(
      "Формат:\n/restore LeadID"
    );
    return;
  }

  const delivery =
    await getPersonalDeliveryByLeadId(
      user.id,
      requestedId
    );

  if (
    !delivery ||
    !restorableLeadStatuses.has(
      delivery.status
    )
  ) {
    await ctx.reply(
      "Не нашёл заявку в архиве или удалённых."
    );
    return;
  }

  const restored =
    await prisma.leadDelivery.update({
      where: {
        id: delivery.id
      },
      data: {
        status: LeadStatus.NEW
      },
      select:
        personalLeadDeliverySelect
    });

  await ctx.reply(
    `✅ Заявка восстановлена: ${
      getShortLeadId(restored.lead.id)
    }`
  );

  await sendPersonalLeadCard(restored);
});

bot.command("note", async (ctx, next) => {
  if (assertAdmin(ctx)) {
    await next();
    return;
  }

  const user =
    await requirePersonalBotUser(ctx);

  if (!user) return;

  const text =
    ctx.message?.text ?? "";

  const [
    ,
    requestedId,
    ...noteParts
  ] = text.trim().split(/\s+/);

  const note =
    noteParts.join(" ").trim();

  if (!requestedId || !note) {
    await ctx.reply(
      "Формат:\n/note LeadID текст заметки"
    );
    return;
  }

  const delivery =
    await getPersonalDeliveryByLeadId(
      user.id,
      requestedId
    );

  if (!delivery) {
    await ctx.reply(
      "Заявка не найдена среди ваших лидов."
    );
    return;
  }

  const updated =
    await prisma.leadDelivery.update({
      where: {
        id: delivery.id
      },
      data: {
        note
      },
      select:
        personalLeadDeliverySelect
    });

  await ctx.reply(
    "📝 Заметка сохранена."
  );

  await sendPersonalLeadCard(updated);
});

bot.command("stats", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const [total, fresh, contacted, waiting, progress, won, lost, ignored, deleted] =
    await Promise.all([
      prisma.lead.count(),
      prisma.lead.count({ where: { status: LeadStatus.NEW } }),
      prisma.lead.count({ where: { status: LeadStatus.CONTACTED } }),
      prisma.lead.count({ where: { status: LeadStatus.WAITING_REPLY } }),
      prisma.lead.count({ where: { status: LeadStatus.IN_PROGRESS } }),
      prisma.lead.count({ where: { status: LeadStatus.WON } }),
      prisma.lead.count({ where: { status: LeadStatus.LOST } }),
      prisma.lead.count({ where: { status: LeadStatus.IGNORED } }),
      prisma.lead.count({ where: { status: LeadStatus.DELETED } })
    ]);

  const [sites, landings, shops, support, unknown] = await Promise.all([
    prisma.lead.count({ where: { category: LeadCategory.SITE } }),
    prisma.lead.count({ where: { category: LeadCategory.LANDING } }),
    prisma.lead.count({ where: { category: LeadCategory.SHOP } }),
    prisma.lead.count({ where: { category: LeadCategory.SUPPORT } }),
    prisma.lead.count({ where: { category: LeadCategory.UNKNOWN } })
  ]);

  await ctx.reply(
    [
      "📊 Статистика лидов",
      "",
      `Всего: ${total}`,
      `Горячие / новые: ${fresh}`,
      `Связался: ${contacted}`,
      `Ждём ответ: ${waiting}`,
      `В обсуждении: ${progress}`,
      `В работе: ${won}`,
      `Отказ: ${lost}`,
      `Архив: ${ignored}`,
      `Удалённые: ${deleted}`,
      "",
      "По типам:",
      `Сайты: ${sites}`,
      `Лендинги: ${landings}`,
      `Магазины: ${shops}`,
      `Доработки: ${support}`,
      `Неясные: ${unknown}`
    ].join("\n")
  );
});

bot.command("leads", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const leads = await prisma.lead.findMany({
    where: {
      status: {
        in: [
          LeadStatus.NEW,
          LeadStatus.CONTACTED,
          LeadStatus.WAITING_REPLY,
          LeadStatus.IN_PROGRESS
        ]
      }
    },
    orderBy: {
      lastTriggeredAt: "desc"
    },
    take: 10,
    select: leadNotificationSelect
  });

  await ctx.reply(formatLeadList("🔥 <b>Активные заявки</b>", leads), {
    parse_mode: "HTML",
    reply_markup: buildLeadListKeyboard(leads),
    link_preview_options: {
      is_disabled: true
    }
  });
});

bot.command("work", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const leads = await prisma.lead.findMany({
    where: {
      status: LeadStatus.WON
    },
    orderBy: {
      updatedAt: "desc"
    },
    take: 10,
    select: leadNotificationSelect
  });

  await ctx.reply(
    formatLeadList(
      "🏆 <b>Заявки в работе</b>",
      leads
    ),
    {
      parse_mode: "HTML",
      reply_markup:
        buildLeadListKeyboard(leads),
      link_preview_options: {
        is_disabled: true
      }
    }
  );
});

bot.command("lead", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const requestedId = ctx.message?.text.trim().split(/\s+/)[1];

  if (!requestedId) {
    await ctx.reply("Укажи Lead ID.\n\nПример:\n/lead e7mpkltd");
    return;
  }

  const lead = await findLeadById(requestedId);

  if (!lead) {
    await ctx.reply("Заявка не найдена.");
    return;
  }

  await ctx.reply(formatLeadNotification(lead), getSendOptions(lead));
});

bot.command("archive", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const leads = await prisma.lead.findMany({
    where: {
      status: LeadStatus.IGNORED
    },
    orderBy: {
      updatedAt: "desc"
    },
    take: 10,
    select: leadNotificationSelect
  });

  await ctx.reply(formatLeadList("🗄 <b>Архив заявок</b>", leads), {
    parse_mode: "HTML",
    reply_markup: buildArchiveKeyboard(leads),
    link_preview_options: {
      is_disabled: true
    }
  });
});

bot.command("trash", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const leads = await prisma.lead.findMany({
    where: {
      status: LeadStatus.DELETED
    },
    orderBy: {
      updatedAt: "desc"
    },
    take: 10,
    select: leadNotificationSelect
  });

  await ctx.reply(formatLeadList("🗑 <b>Удалённые заявки</b>", leads), {
    parse_mode: "HTML",
    reply_markup: buildTrashKeyboard(leads),
    link_preview_options: {
      is_disabled: true
    }
  });
});

bot.command("restore", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const requestedId = ctx.message?.text.trim().split(/\s+/)[1];

  if (!requestedId) {
    await ctx.reply("Укажи Lead ID.\n\nПример:\n/restore e7mpkltd");
    return;
  }

  const lead = await findLeadById(requestedId);

  if (!lead || !restorableLeadStatuses.has(lead.status)) {
    await ctx.reply("Не нашёл заявку в архиве/удалённых.");
    return;
  }

  const restoredLead = await restoreArchivedLead(lead.id);

  if (!restoredLead) {
    await ctx.reply("Не удалось восстановить заявку.");
    return;
  }

  await ctx.reply(`✅ Заявка восстановлена: ${getShortLeadId(restoredLead.id)}`);
});

bot.command("note", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const text = ctx.message?.text ?? "";
  const [, requestedId, ...noteParts] = text.trim().split(/\s+/);
  const note = noteParts.join(" ").trim();

  if (!requestedId || !note) {
    await ctx.reply("Формат:\n/note LeadID текст заметки");
    return;
  }

  const lead = await findLeadById(requestedId);

  if (!lead) {
    await ctx.reply("Заявка не найдена.");
    return;
  }

  const updatedLead = await prisma.lead.update({
    where: {
      id: lead.id
    },
    data: {
      note
    },
    select: leadNotificationSelect
  });

  await ctx.reply("📝 Заметка сохранена.");
  await ctx.reply(formatLeadNotification(updatedLead), getSendOptions(updatedLead));
});

bot.command("banuser", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const text = ctx.message?.text ?? "";
  const [, telegramId, ...reasonParts] = text.trim().split(/\s+/);
  const reason = reasonParts.join(" ").trim() || null;

  if (!telegramId) {
    await ctx.reply("Формат:\n/banuser 123456789 причина");
    return;
  }

  await prisma.bannedUser.upsert({
    where: {
      telegramId
    },
    update: {
      reason
    },
    create: {
      telegramId,
      reason
    }
  });

  await ctx.reply(`🚫 Пользователь забанен: ${telegramId}`);
});

bot.command("unbanuser", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const telegramId = ctx.message?.text.trim().split(/\s+/)[1];

  if (!telegramId) {
    await ctx.reply("Формат:\n/unbanuser 123456789");
    return;
  }

  await prisma.bannedUser.deleteMany({
    where: {
      telegramId
    }
  });

  await ctx.reply(`✅ Пользователь разбанен: ${telegramId}`);
});

bot.command("banlist", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const users = await prisma.bannedUser.findMany({
    orderBy: {
      createdAt: "desc"
    },
    take: 30
  });

  if (!users.length) {
    await ctx.reply("Список забаненных пуст.");
    return;
  }

  await ctx.reply(
    [
      "🚫 Забаненные пользователи",
      "",
      users
        .map((user, index) =>
          `${index + 1}. ${user.telegramId}${user.reason ? ` — ${user.reason}` : ""}`
        )
        .join("\n")
    ].join("\n")
  );
});

bot.command("blackwords", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const words = await prisma.blackWord.findMany({
    orderBy: {
      createdAt: "desc"
    }
  });

  if (!words.length) {
    await ctx.reply("Чёрных слов пока нет.");
    return;
  }

  await ctx.reply(
    [
      "🧱 Чёрные слова",
      "",
      words.map((word, index) => `${index + 1}. ${word.phrase}`).join("\n")
    ].join("\n")
  );
});

bot.command("addblackword", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const phrase = ctx.message?.text.replace(/^\/addblackword(@\w+)?\s*/i, "").trim();

  if (!phrase) {
    await ctx.reply("Формат:\n/addblackword вакансия");
    return;
  }

  await prisma.blackWord.upsert({
    where: {
      phrase: normalizePlain(phrase)
    },
    update: {},
    create: {
      phrase: normalizePlain(phrase)
    }
  });

  await ctx.reply(`✅ Чёрное слово добавлено: ${phrase}`);
});

bot.command("removeblackword", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const phrase = ctx.message?.text.replace(/^\/removeblackword(@\w+)?\s*/i, "").trim();

  if (!phrase) {
    await ctx.reply("Формат:\n/removeblackword вакансия");
    return;
  }

  await prisma.blackWord.deleteMany({
    where: {
      phrase: normalizePlain(phrase)
    }
  });

  await ctx.reply(`✅ Чёрное слово удалено: ${phrase}`);
});

bot.command("chats", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const chats = await prisma.sourceChat.findMany({
    orderBy: {
      updatedAt: "desc"
    },
    take: 30
  });

  if (!chats.length) {
    await ctx.reply("Источников пока нет.");
    return;
  }

  await ctx.reply(
    [
      "📍 Источники",
      "",
      chats
        .map((chat, index) =>
          [
            `${index + 1}. ${chat.isBlocked ? "🚫" : "✅"} ${chat.title}`,
            `ID: ${chat.chatId}`
          ].join("\n")
        )
        .join("\n\n")
    ].join("\n")
  );
});

bot.command("blockchat", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const chatId = ctx.message?.text.trim().split(/\s+/)[1];

  if (!chatId) {
    await ctx.reply("Формат:\n/blockchat -100123456789");
    return;
  }

  await prisma.sourceChat.upsert({
    where: {
      chatId
    },
    update: {
      isBlocked: true
    },
    create: {
      chatId,
      title: chatId,
      isBlocked: true
    }
  });

  await ctx.reply(`🚫 Источник заблокирован: ${chatId}`);
});

bot.command("unblockchat", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const chatId = ctx.message?.text.trim().split(/\s+/)[1];

  if (!chatId) {
    await ctx.reply("Формат:\n/unblockchat -100123456789");
    return;
  }

  await prisma.sourceChat.upsert({
    where: {
      chatId
    },
    update: {
      isBlocked: false
    },
    create: {
      chatId,
      title: chatId,
      isBlocked: false
    }
  });

  await ctx.reply(`✅ Источник разблокирован: ${chatId}`);
});

bot.callbackQuery(
  "subscription:view",
  async (ctx) => {
    await ctx.answerCallbackQuery();

    await replyWithSubscriptionProfile(
      ctx,
      "💳 <b>Моя подписка</b>"
    );
  }
);

bot.callbackQuery(
  "plans:view",
  async (ctx) => {
    await ctx.answerCallbackQuery();
    await replyWithPlans(ctx);
  }
);

function parsePaymentPlanCallbackData(
  data: string
): PaidPlanCode | null {
  const parts =
    data.split(":");

  if (
    parts.length !== 3 ||
    parts[0] !== "payment" ||
    parts[1] !== "plan"
  ) {
    return null;
  }

  return parsePaidPlanCode(
    parts[2]
  );
}

function parsePaymentProviderCallbackData(
  data: string
): {
  provider: PaymentProvider;
  planCode: PaidPlanCode;
} | null {
  const parts =
    data.split(":");

  if (
    parts.length !== 4 ||
    parts[0] !== "payment" ||
    parts[1] !== "provider"
  ) {
    return null;
  }

  let provider: PaymentProvider;

  switch (parts[2]) {
    case "TELEGRAM_STARS":
      provider =
        PaymentProvider.TELEGRAM_STARS;
      break;
    case "YOOKASSA":
      provider =
        PaymentProvider.YOOKASSA;
      break;
    case "ROBOKASSA":
      provider =
        PaymentProvider.ROBOKASSA;
      break;
    default:
      return null;
  }

  const planCode =
    parsePaidPlanCode(
      parts[3]
    );

  if (!planCode) {
    return null;
  }

  return {
    provider,
    planCode
  };
}

bot.callbackQuery(
  /^payment:plan:(START|PRO)$/,
  async (ctx) => {
    const planCode =
      parsePaymentPlanCallbackData(
        ctx.callbackQuery.data
      );

    if (!planCode) {
      await ctx.answerCallbackQuery({
        text: "Некорректный тариф",
        show_alert: true
      });
      return;
    }

    const user =
      await getCurrentBotUser(ctx);

    if (!user) {
      await ctx.answerCallbackQuery({
        text: "Сначала выполните /start",
        show_alert: true
      });
      return;
    }

    if (!user.isActive) {
      await ctx.answerCallbackQuery({
        text: "Аккаунт отключён",
        show_alert: true
      });
      return;
    }

    if (
      user.role ===
      UserRole.OWNER
    ) {
      await ctx.answerCallbackQuery({
        text: "У владельца бессрочный доступ",
        show_alert: true
      });
      return;
    }

    await ctx.answerCallbackQuery();

    await replyWithPaymentMethods(
      ctx,
      planCode
    );
  }
);

bot.callbackQuery(
  /^payment:provider:(TELEGRAM_STARS|YOOKASSA|ROBOKASSA):(START|PRO)$/,
  async (ctx) => {
    const selection =
      parsePaymentProviderCallbackData(
        ctx.callbackQuery.data
      );

    if (!selection) {
      await ctx.answerCallbackQuery({
        text: "Некорректный способ оплаты",
        show_alert: true
      });
      return;
    }

    const user =
      await getCurrentBotUser(ctx);

    if (!user) {
      await ctx.answerCallbackQuery({
        text: "Сначала выполните /start",
        show_alert: true
      });
      return;
    }

    if (!user.isActive) {
      await ctx.answerCallbackQuery({
        text: "Аккаунт отключён",
        show_alert: true
      });
      return;
    }

    if (
      user.role ===
      UserRole.OWNER
    ) {
      await ctx.answerCallbackQuery({
        text: "У владельца бессрочный доступ",
        show_alert: true
      });
      return;
    }

    if (
      selection.provider !==
      PaymentProvider.TELEGRAM_STARS
    ) {
      await ctx.answerCallbackQuery({
        text:
          "Этот способ оплаты подключается. Сейчас доступна оплата Telegram Stars.",
        show_alert: true
      });
      return;
    }

    const offer =
      PAYMENT_OFFERS[
        selection.planCode
      ];

    const configuredAmount =
      getConfiguredPaymentAmount(
        selection.provider,
        offer
      );

    if (!configuredAmount) {
      await ctx.answerCallbackQuery({
        text:
          selection.provider ===
          PaymentProvider.TELEGRAM_STARS
            ? "Цена в Stars пока не настроена"
            : "Цена в рублях пока не настроена",
        show_alert: true
      });
      return;
    }

    try {
      const payment =
        await createPaymentRecord(
          user.id,
          selection.provider,
          selection.planCode
        );

      if (!payment) {
        await ctx.answerCallbackQuery({
          text: "Цена не настроена",
          show_alert: true
        });
        return;
      }

      const plan =
        PLAN_DEFINITIONS[
          selection.planCode
        ];

      if (
        selection.provider ===
        PaymentProvider.TELEGRAM_STARS
      ) {
        await sendTelegramStarsInvoice(
          ctx,
          payment,
          selection.planCode
        );

        await ctx.answerCallbackQuery({
          text: "Счёт в Telegram Stars создан"
        });

        return;
      }

      await ctx.answerCallbackQuery({
        text: "Платёж подготовлен"
      });

      await ctx.reply(
        [
          "🧾 <b>Платёжная запись создана</b>",
          "",
          `Тариф: ${escapeHtml(plan.label)}`,
          `Способ: ${escapeHtml(
            getPaymentProviderLabel(
              selection.provider
            )
          )}`,
          `Сумма: ${escapeHtml(
            formatRubPrice(
              configuredAmount.amountMinor
            )
          )}`,
          `Срок: ${payment.durationDays} дн.`,
          "",
          `ID заказа: <code>${escapeHtml(
            payment.id
          )}</code>`,
          "",
          "Подключение API этого провайдера будет выполнено следующим этапом."
        ].join("\n"),
        {
          parse_mode: "HTML"
        }
      );
    } catch (error) {
      console.error(
        "PAYMENT_CREATE_ERROR",
        {
          userId: user.id,
          provider:
            selection.provider,
          planCode:
            selection.planCode,
          error
        }
      );

      await ctx.answerCallbackQuery({
        text: "Не удалось подготовить платёж",
        show_alert: true
      });
    }
  }
);

bot.on(
  "pre_checkout_query",
  async (ctx) => {
    const query =
      ctx.preCheckoutQuery;

    const paymentId =
      parseTelegramStarsInvoicePayload(
        query.invoice_payload
      );

    if (!paymentId) {
      await ctx.answerPreCheckoutQuery(
        false,
        "Некорректный платёжный заказ."
      );
      return;
    }

    try {
      const payment =
        await prisma.payment.findUnique({
          where: {
            id: paymentId
          },
          include: {
            user: {
              select: {
                telegramId: true,
                role: true,
                isActive: true
              }
            }
          }
        });

      if (!payment) {
        await ctx.answerPreCheckoutQuery(
          false,
          "Платёжный заказ не найден."
        );
        return;
      }

      if (
        payment.provider !==
        PaymentProvider.TELEGRAM_STARS
      ) {
        await ctx.answerPreCheckoutQuery(
          false,
          "Для заказа выбран другой способ оплаты."
        );
        return;
      }

      if (
        payment.expiresAt.getTime() <=
        Date.now()
      ) {
        await ctx.answerPreCheckoutQuery(
          false,
          "Срок действия счёта истёк. Создайте новый заказ через /plans."
        );

        await prisma.payment.updateMany({
          where: {
            id: payment.id,
            activatedAt: null,
            status: {
              in: [
                PaymentStatus.CREATED,
                PaymentStatus.PENDING
              ]
            }
          },
          data: {
            status:
              PaymentStatus.EXPIRED,
            failureReason:
              "Истёк срок действия платёжного заказа"
          }
        }).catch((error) => {
          console.error(
            "PAYMENT_EXPIRY_UPDATE_ERROR",
            {
              paymentId:
                payment.id,
              error
            }
          );
        });

        return;
      }

      if (
        payment.status !==
          PaymentStatus.CREATED &&
        payment.status !==
          PaymentStatus.PENDING
      ) {
        await ctx.answerPreCheckoutQuery(
          false,
          "Этот заказ уже обработан или недоступен."
        );
        return;
      }

      if (payment.activatedAt) {
        await ctx.answerPreCheckoutQuery(
          false,
          "Подписка по этому заказу уже активирована."
        );
        return;
      }

      if (
        payment.user.role ===
        UserRole.OWNER
      ) {
        await ctx.answerPreCheckoutQuery(
          false,
          "Владельцу не требуется платная подписка."
        );
        return;
      }

      if (!payment.user.isActive) {
        await ctx.answerPreCheckoutQuery(
          false,
          "Аккаунт отключён. Обратитесь к владельцу бота."
        );
        return;
      }

      if (
        payment.user.telegramId !==
        String(query.from.id)
      ) {
        await ctx.answerPreCheckoutQuery(
          false,
          "Этот счёт создан для другого пользователя."
        );
        return;
      }

      if (
        query.currency !== "XTR" ||
        payment.currency !== "XTR"
      ) {
        await ctx.answerPreCheckoutQuery(
          false,
          "Некорректная валюта платежа."
        );
        return;
      }

      if (
        query.total_amount !==
        payment.amountMinor
      ) {
        await ctx.answerPreCheckoutQuery(
          false,
          "Сумма платежа не совпадает с заказом."
        );
        return;
      }

      await ctx.answerPreCheckoutQuery(
        true
      );

      await prisma.payment.updateMany({
        where: {
          id: payment.id,
          status: PaymentStatus.CREATED,
          activatedAt: null
        },
        data: {
          status: PaymentStatus.PENDING
        }
      }).catch((error) => {
        console.error(
          "TELEGRAM_STARS_PENDING_UPDATE_ERROR",
          {
            paymentId: payment.id,
            error
          }
        );
      });
    } catch (error) {
      console.error(
        "TELEGRAM_STARS_PRE_CHECKOUT_ERROR",
        {
          paymentId,
          telegramId:
            String(query.from.id),
          error
        }
      );

      await ctx.answerPreCheckoutQuery(
        false,
        "Не удалось проверить заказ. Повторите попытку позже."
      ).catch(() => undefined);
    }
  }
);

bot.on(
  "message:successful_payment",
  async (ctx) => {
    const successfulPayment =
      ctx.message.successful_payment;

    const paymentId =
      parseTelegramStarsInvoicePayload(
        successfulPayment.invoice_payload
      );

    if (!paymentId) {
      console.error(
        "TELEGRAM_STARS_INVALID_SUCCESS_PAYLOAD",
        {
          telegramId:
            String(ctx.from.id),
          payload:
            successfulPayment.invoice_payload
        }
      );

      await ctx.reply(
        [
          "⚠️ Оплата получена, но заказ не удалось определить.",
          "",
          "Обратитесь в поддержку: /paysupport"
        ].join("\n")
      );

      return;
    }

    let paymentEventId:
      string | null = null;

    try {
      const payment =
        await prisma.payment.findUnique({
          where: {
            id: paymentId
          },
          include: {
            user: {
              select: {
                telegramId: true,
                role: true
              }
            }
          }
        });

      if (!payment) {
        throw new Error(
          `Платёж не найден: ${paymentId}`
        );
      }

      if (
        payment.provider !==
        PaymentProvider.TELEGRAM_STARS
      ) {
        throw new Error(
          "Провайдер платежа не соответствует Telegram Stars"
        );
      }

      if (
        payment.user.telegramId !==
        String(ctx.from.id)
      ) {
        throw new Error(
          "Telegram ID плательщика не совпадает с заказом"
        );
      }

      if (
        payment.user.role ===
        UserRole.OWNER
      ) {
        throw new Error(
          "Владельцу не требуется платная подписка"
        );
      }

      if (
        successfulPayment.currency !==
          "XTR" ||
        payment.currency !== "XTR"
      ) {
        throw new Error(
          "Некорректная валюта успешного платежа"
        );
      }

      if (
        successfulPayment.total_amount !==
        payment.amountMinor
      ) {
        throw new Error(
          "Сумма успешного платежа не совпадает с заказом"
        );
      }

      const telegramChargeId =
        successfulPayment
          .telegram_payment_charge_id;

      const externalEventKey =
        `successful_payment:${telegramChargeId}`;

      const paymentEvent =
        await prisma.paymentEvent.upsert({
          where: {
            provider_externalEventKey: {
              provider:
                PaymentProvider.TELEGRAM_STARS,
              externalEventKey
            }
          },
          update: {
            paymentId: payment.id
          },
          create: {
            paymentId: payment.id,
            provider:
              PaymentProvider.TELEGRAM_STARS,
            externalEventKey,
            eventType:
              "successful_payment",
            payload: {
              paymentId: payment.id,
              telegramId:
                String(ctx.from.id),
              currency:
                successfulPayment.currency,
              totalAmount:
                successfulPayment.total_amount,
              invoicePayload:
                successfulPayment.invoice_payload,
              telegramPaymentChargeId:
                telegramChargeId,
              providerPaymentChargeId:
                successfulPayment
                  .provider_payment_charge_id
            }
          }
        });

      paymentEventId =
        paymentEvent.id;

      const activation =
        await activateSubscriptionFromPayment(
          payment.id,
          telegramChargeId
        );

      await prisma.paymentEvent.update({
        where: {
          id: paymentEvent.id
        },
        data: {
          processedAt: new Date(),
          processingError: null
        }
      });

      if (!activation.alreadyActivated) {
        const plan =
          PLAN_DEFINITIONS[
            activation.planCode
          ];

        await bot.api.sendMessage(
          adminTargetChatId,
          [
            "💰 Оплата Telegram Stars",
            "",
            `Пользователь: ${payment.user.telegramId}`,
            `Тариф: ${plan.label}`,
            `Сумма: ${payment.amountMinor} Stars`,
            `Заказ: ${payment.id}`,
            `Charge ID: ${telegramChargeId}`,
            `Доступ до: ${formatAccessDate(
              activation.expiresAt
            )}`
          ].join("\n")
        ).catch((error) => {
          console.error(
            "TELEGRAM_STARS_OWNER_NOTIFY_ERROR",
            {
              paymentId:
                payment.id,
              error
            }
          );
        });
      }
    } catch (error) {
      console.error(
        "TELEGRAM_STARS_SUCCESS_ERROR",
        {
          paymentId,
          paymentEventId,
          telegramId:
            String(ctx.from.id),
          error
        }
      );

      if (paymentEventId) {
        await prisma.paymentEvent.update({
          where: {
            id: paymentEventId
          },
          data: {
            processingError:
              error instanceof Error
                ? error.message
                : String(error)
          }
        }).catch(() => undefined);
      }

      await ctx.reply(
        [
          "⚠️ Оплата получена, но подписка требует ручной проверки.",
          "",
          `ID заказа: ${paymentId}`,
          "",
          "Обратитесь в поддержку: /paysupport"
        ].join("\n")
      );
    }
  }
);

async function getTriggerCallbackUser(
  ctx: Context
) {
  const user =
    await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.answerCallbackQuery({
      text: "Сначала выполните /start"
    });
    return null;
  }

  if (!hasSubscriptionAccess(user)) {
    await ctx.answerCallbackQuery({
      text: user.isActive
        ? "Подписка неактивна"
        : "Аккаунт отключён",
      show_alert: true
    });
    return null;
  }

  return user;
}

bot.callbackQuery("triggers:list", async (ctx) => {
  const user =
    await getTriggerCallbackUser(ctx);

  if (!user) return;

  await ctx.answerCallbackQuery({
    text: "Триггеры обновлены"
  });

  await editUserTriggersMessage(ctx, user.id);
});

bot.callbackQuery("triggers:add", async (ctx) => {
  const user =
    await getTriggerCallbackUser(ctx);

  if (!user) return;

  await ctx.answerCallbackQuery({
    text: "Отправьте команду с фразой"
  });

  await ctx.reply(
    [
      "➕ <b>Добавление триггера</b>",
      "",
      "Отправьте команду:",
      "<code>/addtrigger нужная фраза</code>",
      "",
      "Пример:",
      "<code>/addtrigger требуется дизайнер</code>"
    ].join("\n"),
    {
      parse_mode: "HTML"
    }
  );
});

bot.callbackQuery(/^trigger:toggle:/, async (ctx) => {
  const user =
    await getTriggerCallbackUser(ctx);

  if (!user) return;

  const [, , triggerId] =
    (ctx.callbackQuery.data ?? "").split(":");

  if (!triggerId) {
    await ctx.answerCallbackQuery({
      text: "Некорректный триггер"
    });
    return;
  }

  const trigger = await prisma.userTrigger.findFirst({
    where: {
      id: triggerId,
      userId: user.id
    },
    select: {
      id: true,
      isActive: true
    }
  });

  if (!trigger) {
    await ctx.answerCallbackQuery({
      text: "Триггер не найден"
    });
    return;
  }

  if (!trigger.isActive) {
    const plan =
      getPlanDefinition(user);

    if (plan.maxTriggers !== null) {
      const activeTriggerCount =
        await prisma.userTrigger.count({
          where: {
            userId: user.id,
            isActive: true
          }
        });

      if (
        activeTriggerCount >=
        plan.maxTriggers
      ) {
        await ctx.answerCallbackQuery({
          text:
            `Лимит тарифа: ${plan.maxTriggers} активных триггеров`,
          show_alert: true
        });
        return;
      }
    }
  }

  const updatedTrigger =
    await prisma.userTrigger.update({
      where: {
        id: trigger.id
      },
      data: {
        isActive: !trigger.isActive
      },
      select: {
        id: true,
        phrase: true,
        isActive: true
      }
    });

  console.log("USER_TRIGGER_TOGGLED", {
    userId: user.id,
    telegramId: user.telegramId,
    triggerId: updatedTrigger.id,
    isActive: updatedTrigger.isActive
  });

  await ctx.answerCallbackQuery({
    text: updatedTrigger.isActive
      ? "Триггер включён"
      : "Триггер отключён"
  });

  await editUserTriggersMessage(ctx, user.id);
});

bot.callbackQuery(/^trigger:delete:/, async (ctx) => {
  const user =
    await getTriggerCallbackUser(ctx);

  if (!user) return;

  const [, , triggerId] =
    (ctx.callbackQuery.data ?? "").split(":");

  if (!triggerId) {
    await ctx.answerCallbackQuery({
      text: "Некорректный триггер"
    });
    return;
  }

  const deleted = await prisma.userTrigger.deleteMany({
    where: {
      id: triggerId,
      userId: user.id
    }
  });

  if (!deleted.count) {
    await ctx.answerCallbackQuery({
      text: "Триггер не найден"
    });
    return;
  }

  console.log("USER_TRIGGER_DELETED", {
    userId: user.id,
    telegramId: user.telegramId,
    triggerId
  });

  await ctx.answerCallbackQuery({
    text: "Триггер удалён"
  });

  await editUserTriggersMessage(ctx, user.id);
});

bot.callbackQuery(/^pcount:/, async (ctx) => {
  const user =
    await getCurrentBotUser(ctx);

  if (
    !user ||
    !hasSubscriptionAccess(user)
  ) {
    await ctx.answerCallbackQuery({
      text: "Нет доступа"
    });
    return;
  }

  const [, leadId] =
    (ctx.callbackQuery.data ?? "")
      .split(":");

  const delivery =
    leadId
      ? await getPersonalDeliveryByLeadId(
          user.id,
          leadId
        )
      : null;

  if (
    !delivery ||
    delivery.recipientChatId !==
      String(ctx.chat?.id)
  ) {
    await ctx.answerCallbackQuery({
      text: "Заявка не найдена"
    });
    return;
  }

  await ctx.answerCallbackQuery({
    text: `Сработок от клиента: ${delivery.lead.triggerCount}`
  });
});

bot.callbackQuery(/^pshow:/, async (ctx) => {
  const user =
    await getCurrentBotUser(ctx);

  if (
    !user ||
    !hasSubscriptionAccess(user)
  ) {
    await ctx.answerCallbackQuery({
      text: "Нет доступа"
    });
    return;
  }

  const [, leadId] =
    (ctx.callbackQuery.data ?? "")
      .split(":");

  const delivery =
    leadId
      ? await getPersonalDeliveryByLeadId(
          user.id,
          leadId
        )
      : null;

  if (!delivery) {
    await ctx.answerCallbackQuery({
      text: "Заявка не найдена"
    });
    return;
  }

  await ctx.answerCallbackQuery({
    text: "Открываю заявку"
  });

  await ctx.reply(
    formatPersonalLeadNotification(
      delivery
    ),
    getPersonalLeadSendOptions(delivery)
  );
});

bot.callbackQuery(/^pstatus:/, async (ctx) => {
  const user =
    await getCurrentBotUser(ctx);

  if (
    !user ||
    !hasSubscriptionAccess(user)
  ) {
    await ctx.answerCallbackQuery({
      text: "Нет доступа"
    });
    return;
  }

  const [
    ,
    action,
    leadId
  ] = (ctx.callbackQuery.data ?? "")
    .split(":");

  if (!leadId) {
    await ctx.answerCallbackQuery({
      text: "Некорректный Lead ID"
    });
    return;
  }

  const actionToStatus:
    Record<string, LeadStatus> = {
      contacted: LeadStatus.CONTACTED,
      waiting:
        LeadStatus.WAITING_REPLY,
      progress:
        LeadStatus.IN_PROGRESS,
      won: LeadStatus.WON,
      lost: LeadStatus.LOST,
      ignored: LeadStatus.IGNORED
    };

  const nextStatus =
    actionToStatus[action];

  if (!nextStatus) {
    await ctx.answerCallbackQuery({
      text: "Некорректное действие"
    });
    return;
  }

  const delivery =
    await getPersonalDeliveryByLeadId(
      user.id,
      leadId
    );

  if (
    !delivery ||
    delivery.recipientChatId !==
      String(ctx.chat?.id)
  ) {
    await ctx.answerCallbackQuery({
      text: "Заявка не найдена"
    });
    return;
  }

  const updated =
    await prisma.leadDelivery.update({
      where: {
        id: delivery.id
      },
      data: {
        status: nextStatus
      },
      select:
        personalLeadDeliverySelect
    });

  await ctx.answerCallbackQuery({
    text:
      action === "ignored"
        ? "Заявка отправлена в архив"
        : "Статус обновлён"
  });

  if (action === "ignored") {
    await animatePersonalArchiveDeletion(
      ctx,
      updated
    );
    return;
  }

  await editPersonalLeadMessage(
    ctx,
    updated
  );
});

bot.callbackQuery(
  /^parchive-restore:/,
  async (ctx) => {
    const user =
      await getCurrentBotUser(ctx);

    if (
      !user ||
      !hasSubscriptionAccess(user)
    ) {
      await ctx.answerCallbackQuery({
        text: "Нет доступа"
      });
      return;
    }

    const [, leadId] =
      (ctx.callbackQuery.data ?? "")
        .split(":");

    const delivery =
      leadId
        ? await getPersonalDeliveryByLeadId(
            user.id,
            leadId
          )
        : null;

    if (
      !delivery ||
      delivery.recipientChatId !==
        String(ctx.chat?.id) ||
      delivery.status !==
        LeadStatus.IGNORED
    ) {
      await ctx.answerCallbackQuery({
        text: "Заявка не найдена в архиве"
      });
      return;
    }

    await prisma.leadDelivery.update({
      where: {
        id: delivery.id
      },
      data: {
        status: LeadStatus.NEW
      }
    });

    const deliveries =
      await prisma.leadDelivery.findMany({
        where: {
          recipientUserId: user.id,
          deliveryType:
            LeadDeliveryType.USER_TRIGGER,
          status: LeadStatus.IGNORED
        },
        orderBy: {
          updatedAt: "desc"
        },
        take: 10,
        select:
          personalLeadDeliverySelect
      });

    await ctx.answerCallbackQuery({
      text: `Восстановлено: ${getShortLeadId(
        delivery.lead.id
      )}`
    });

    await ctx.editMessageText(
      formatPersonalLeadList(
        "🗄 <b>Мой архив</b>",
        deliveries
      ),
      {
        parse_mode: "HTML",
        reply_markup:
          buildPersonalArchiveKeyboard(
            deliveries
          ),
        link_preview_options: {
          is_disabled: true
        }
      }
    );

    console.log(
      "PERSONAL_ARCHIVE_RESTORED",
      {
        userId: user.id,
        leadId: delivery.lead.id
      }
    );
  }
);

bot.callbackQuery(
  /^parchive-delete:/,
  async (ctx) => {
    const user =
      await getCurrentBotUser(ctx);

    if (
      !user ||
      !hasSubscriptionAccess(user)
    ) {
      await ctx.answerCallbackQuery({
        text: "Нет доступа"
      });
      return;
    }

    const [, leadId] =
      (ctx.callbackQuery.data ?? "")
        .split(":");

    const delivery =
      leadId
        ? await getPersonalDeliveryByLeadId(
            user.id,
            leadId
          )
        : null;

    if (
      !delivery ||
      delivery.recipientChatId !==
        String(ctx.chat?.id) ||
      delivery.status !==
        LeadStatus.IGNORED
    ) {
      await ctx.answerCallbackQuery({
        text: "Заявка не найдена в архиве"
      });
      return;
    }

    await prisma.leadDelivery.update({
      where: {
        id: delivery.id
      },
      data: {
        status: LeadStatus.DELETED
      }
    });

    const deliveries =
      await prisma.leadDelivery.findMany({
        where: {
          recipientUserId: user.id,
          deliveryType:
            LeadDeliveryType.USER_TRIGGER,
          status: LeadStatus.IGNORED
        },
        orderBy: {
          updatedAt: "desc"
        },
        take: 10,
        select:
          personalLeadDeliverySelect
      });

    await ctx.answerCallbackQuery({
      text: `Перемещено в удалённые: ${getShortLeadId(
        delivery.lead.id
      )}`
    });

    await ctx.editMessageText(
      formatPersonalLeadList(
        "🗄 <b>Мой архив</b>",
        deliveries
      ),
      {
        parse_mode: "HTML",
        reply_markup:
          buildPersonalArchiveKeyboard(
            deliveries
          ),
        link_preview_options: {
          is_disabled: true
        }
      }
    );

    console.log(
      "PERSONAL_ARCHIVE_DELETED",
      {
        userId: user.id,
        leadId: delivery.lead.id
      }
    );
  }
);

bot.callbackQuery(/^prestore:/, async (ctx) => {
  const user =
    await getCurrentBotUser(ctx);

  if (
    !user ||
    !hasSubscriptionAccess(user)
  ) {
    await ctx.answerCallbackQuery({
      text: "Нет доступа"
    });
    return;
  }

  const [, leadId] =
    (ctx.callbackQuery.data ?? "")
      .split(":");

  const delivery =
    leadId
      ? await getPersonalDeliveryByLeadId(
          user.id,
          leadId
        )
      : null;

  if (
    !delivery ||
    delivery.recipientChatId !==
      String(ctx.chat?.id) ||
    !restorableLeadStatuses.has(
      delivery.status
    )
  ) {
    await ctx.answerCallbackQuery({
      text: "Нельзя восстановить"
    });
    return;
  }

  const restored =
    await prisma.leadDelivery.update({
      where: {
        id: delivery.id
      },
      data: {
        status: LeadStatus.NEW
      },
      select:
        personalLeadDeliverySelect
    });

  await ctx.answerCallbackQuery({
    text: "Заявка восстановлена"
  });

  await editPersonalLeadMessage(
    ctx,
    restored
  );
});

bot.callbackQuery(/^pdelete:/, async (ctx) => {
  const user =
    await getCurrentBotUser(ctx);

  if (
    !user ||
    !hasSubscriptionAccess(user)
  ) {
    await ctx.answerCallbackQuery({
      text: "Нет доступа"
    });
    return;
  }

  const [, leadId] =
    (ctx.callbackQuery.data ?? "")
      .split(":");

  const delivery =
    leadId
      ? await getPersonalDeliveryByLeadId(
          user.id,
          leadId
        )
      : null;

  if (
    !delivery ||
    delivery.recipientChatId !==
      String(ctx.chat?.id) ||
    delivery.status !==
      LeadStatus.IGNORED
  ) {
    await ctx.answerCallbackQuery({
      text: "Заявка не найдена в архиве"
    });
    return;
  }

  const deleted =
    await prisma.leadDelivery.update({
      where: {
        id: delivery.id
      },
      data: {
        status: LeadStatus.DELETED
      },
      select:
        personalLeadDeliverySelect
    });

  await ctx.answerCallbackQuery({
    text: "Заявка перемещена в удалённые"
  });

  await editPersonalLeadMessage(
    ctx,
    deleted
  );
});

bot.callbackQuery(/^counter:/, async (ctx) => {
  if (!assertAdmin(ctx)) {
    await ctx.answerCallbackQuery({
      text: "Нет доступа"
    });
    return;
  }

  await ctx.answerCallbackQuery({
    text: "Это счётчик сработок от клиента. Действие не требуется."
  });
});

bot.callbackQuery(/^show:/, async (ctx) => {
  if (!assertAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }

  const [, leadId] = (ctx.callbackQuery.data ?? "").split(":");
  const lead = leadId ? await findLeadById(leadId) : null;

  if (!lead) {
    await ctx.answerCallbackQuery({ text: "Заявка не найдена" });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Открываю заявку" });
  await ctx.reply(formatLeadNotification(lead), getSendOptions(lead));
});

bot.callbackQuery(/^restore:/, async (ctx) => {
  if (!assertAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }

  const [, leadId] = (ctx.callbackQuery.data ?? "").split(":");

  if (!leadId) {
    await ctx.answerCallbackQuery({ text: "Некорректный Lead ID" });
    return;
  }

  const restoredLead = await restoreArchivedLead(leadId);

  if (!restoredLead) {
    await ctx.answerCallbackQuery({
      text: "Заявка не найдена в архиве/удалённых или уже восстановлена."
    });
    return;
  }

  await ctx.answerCallbackQuery({
    text: `Восстановлено: ${getShortLeadId(restoredLead.id)}`
  });
});

bot.callbackQuery(/^delete-archived:/, async (ctx) => {
  if (!assertAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }

  const [, leadId] = (ctx.callbackQuery.data ?? "").split(":");

  if (!leadId) {
    await ctx.answerCallbackQuery({ text: "Некорректный Lead ID" });
    return;
  }

  const deletedLead = await softDeleteArchivedLead(leadId);

  if (!deletedLead) {
    await ctx.answerCallbackQuery({
      text: "Заявка не найдена в архиве или уже не архивная."
    });
    return;
  }

  const leads = await prisma.lead.findMany({
    where: {
      status: LeadStatus.IGNORED
    },
    orderBy: {
      updatedAt: "desc"
    },
    take: 10,
    select: leadNotificationSelect
  });

  await ctx.answerCallbackQuery({
    text: `Перемещено в удалённые: ${getShortLeadId(deletedLead.id)}`
  });

  await ctx.editMessageText(formatLeadList("🗄 <b>Архив заявок</b>", leads), {
    parse_mode: "HTML",
    reply_markup: buildArchiveKeyboard(leads),
    link_preview_options: {
      is_disabled: true
    }
  }).catch((error) => {
    console.error("ARCHIVE_SOFT_DELETE_EDIT_ERROR", {
      leadId,
      error
    });
  });
});

bot.callbackQuery(/^status:/, async (ctx) => {
  if (!assertAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "Нет доступа" });
    return;
  }

  const data = ctx.callbackQuery.data ?? "";
  const [, action, leadId] = data.split(":");

  if (!leadId) {
    await ctx.answerCallbackQuery({ text: "Некорректный Lead ID" });
    return;
  }

  const actionToStatus: Record<string, LeadStatus> = {
    contacted: LeadStatus.CONTACTED,
    waiting: LeadStatus.WAITING_REPLY,
    progress: LeadStatus.IN_PROGRESS,
    won: LeadStatus.WON,
    lost: LeadStatus.LOST,
    ignored: LeadStatus.IGNORED
  };

  const nextStatus = actionToStatus[action];

  if (!nextStatus) {
    await ctx.answerCallbackQuery({ text: "Некорректное действие" });
    return;
  }

  const targetLead = await prisma.lead.findUnique({
    where: {
      id: leadId
    },
    select: leadNotificationSelect
  });

  if (!targetLead) {
    await ctx.answerCallbackQuery({ text: "Лид не найден" });
    return;
  }

  const activeLeadIds =
    targetLead.authorTelegramId
      ? await prisma.lead.findMany({
          where: {
            authorTelegramId: targetLead.authorTelegramId,
            status: LeadStatus.NEW
          },
          select: {
            id: true
          }
        })
      : [{ id: leadId }];

  for (const activeLead of activeLeadIds) {
    const timer = scheduledHotRefreshes.get(activeLead.id);
    if (timer) {
      clearTimeout(timer);
      scheduledHotRefreshes.delete(activeLead.id);
    }
  }

  const updatedLead = await prisma.lead.update({
    where: {
      id: leadId
    },
    data: {
      status: nextStatus
    },
    select: leadNotificationSelect
  });

  const closedActiveLeads =
    targetLead.authorTelegramId
      ? await prisma.lead.updateMany({
          where: {
            authorTelegramId: targetLead.authorTelegramId,
            status: LeadStatus.NEW,
            id: {
              not: leadId
            }
          },
          data: {
            status: nextStatus
          }
        })
      : { count: 0 };

  console.log("LEAD_CLIENT_ACTIVE_CLOSED", {
    authorTelegramId: targetLead.authorTelegramId,
    status: nextStatus,
    clickedLeadId: leadId,
    closedOtherCount: closedActiveLeads.count
  });

  if (action === "ignored") {
    await ctx.answerCallbackQuery({
      text: "Заявка отправлена в архив"
    });

    await animateArchiveDeletion(ctx, updatedLead);
    return;
  }

  await ctx.answerCallbackQuery({
    text: `Статус обновлён. Закрыто активных карточек клиента: ${closedActiveLeads.count + 1}`
  });

  await ctx
    .editMessageText(formatLeadNotification(updatedLead), getSendOptions(updatedLead))
    .catch((error) => {
      console.error("LEAD_STATUS_EDIT_ERROR", {
        leadId,
        error
      });
    });
});

bot.on("message:text", async (ctx) => {
  cleanupSeenMessages();

  if (ctx.from?.is_bot) return;

  const text = ctx.message.text;

  if (text.trim().startsWith("/")) {
    return;
  }

  await trackSourceChat(ctx);

  if (await isSourceChatBlocked(ctx)) {
    return;
  }

  if (await isUserBanned(ctx)) {
    return;
  }

  const blackWord = await findMatchedBlackWord(text);

  if (blackWord) {
    console.log("LEAD_BLACKWORD_SKIPPED", {
      blackWord,
      chat: getChatTitle(ctx),
      author: getAuthorLine(ctx),
      text
    });
    return;
  }

  // Глобальный поиск сайтов всегда принадлежит владельцу.
  const ownerDetectedLead =
    detectLead(text, minLeadScore);

  // Персональные настройки пользователей работают отдельно.
  const personalRecipients =
    await getPersonalTriggerRecipients(ctx, text);

  if (
    !ownerDetectedLead &&
    !personalRecipients.length
  ) {
    return;
  }

  const key = getMessageKey(ctx);

  if (seenMessages.has(key)) return;
  seenMessages.set(key, Date.now());

  const personalMatches = [
    ...new Set(
      personalRecipients.flatMap(
        (recipient) =>
          recipient.matchedTriggers
      )
    )
  ];

  let ownerAction: string | null = null;
  let ownerLeadId: string | null = null;

  const personalActions: Array<{
    recipientUserId: string;
    action: string;
    leadId: string | null;
  }> = [];

  // Глобальная заявка владельца существует
  // только в области OWNER.
  if (ownerDetectedLead) {
    const ownerResult =
      await createOrUpdateLeadWithSpamGuard(
        ctx,
        ownerDetectedLead,
        text,
        "OWNER",
        true
      );

    ownerAction = ownerResult.action;
    ownerLeadId =
      ownerResult.lead?.id ?? null;

    if (
      ownerResult.action !== "skip" &&
      ownerResult.lead
    ) {
      await deliverOwnerGlobalLead(
        ownerResult.lead
      );

      scheduleHotLeadRefresh(
        ownerResult.lead.id,
        ownerResult.lead.lastTriggeredAt
      );
    }
  }

  // Каждый подписчик получает собственный Lead.
  // Поэтому его архив, работа и удалённые заявки
  // не влияют на других пользователей.
  for (const recipient of personalRecipients) {
    // Владельцу не отправляем вторую карточку,
    // если сработал глобальный детектор сайтов.
    if (
      ownerDetectedLead &&
      recipient.deliveryChatId ===
        adminTargetChatId
    ) {
      continue;
    }

    const personalDetection =
      createTriggerOnlyDetection(
        recipient.matchedTriggers
      );

    const personalResult =
      await createOrUpdateLeadWithSpamGuard(
        ctx,
        personalDetection,
        text,
        `USER:${recipient.userId}`,
        true
      );

    personalActions.push({
      recipientUserId: recipient.userId,
      action: personalResult.action,
      leadId:
        personalResult.lead?.id ?? null
    });

    if (
      personalResult.action === "skip" ||
      !personalResult.lead
    ) {
      continue;
    }

    await deliverPersonalTriggerLead(
      personalResult.lead,
      recipient
    ).catch((error) => {
      console.error(
        "PERSONAL_LEAD_DELIVERY_ERROR",
        {
          leadId:
            personalResult.lead?.id,
          recipientUserId:
            recipient.userId,
          recipientChatId:
            recipient.deliveryChatId,
          error
        }
      );
    });
  }

  console.log("LEAD_ROUTED", {
    key,
    ownerGlobal:
      Boolean(ownerDetectedLead),
    ownerAction,
    ownerLeadId,
    personalRecipientCount:
      personalRecipients.length,
    personalActions,
    personalMatches,
    chat: getChatTitle(ctx),
    author: getAuthorLine(ctx)
  });
});

bot.catch((error) => {
  console.error("BOT_ERROR", error);
});

async function setupBotCommands(): Promise<void> {
  const userCommands = [
    {
      command: "start",
      description: "Открыть главное меню"
    },
    {
      command: "profile",
      description: "Профиль и использование"
    },
    {
      command: "subscription",
      description: "Состояние подписки"
    },
    {
      command: "plans",
      description: "Доступные тарифы"
    },
    {
      command: "paysupport",
      description: "Поддержка по оплате"
    },
    {
      command: "terms",
      description: "Условия использования и оплаты"
    },
    {
      command: "triggers",
      description: "Мои персональные триггеры"
    },
    {
      command: "addtrigger",
      description: "Добавить персональный триггер"
    },
    {
      command: "removetrigger",
      description: "Удалить персональный триггер"
    },
    {
      command: "sources",
      description: "Подключённые источники"
    },
    {
      command: "connectchat",
      description: "Подключить текущую группу"
    },
    {
      command: "disconnectchat",
      description: "Отключить источник"
    },
    {
      command: "stats",
      description: "Личная статистика лидов"
    },
    {
      command: "leads",
      description: "Активные заявки"
    },
    {
      command: "work",
      description: "Заявки в работе"
    },
    {
      command: "lead",
      description: "Открыть заявку по ID"
    },
    {
      command: "archive",
      description: "Архив заявок"
    },
    {
      command: "trash",
      description: "Удалённые заявки"
    },
    {
      command: "restore",
      description: "Восстановить заявку"
    },
    {
      command: "note",
      description: "Добавить заметку"
    },
    {
      command: "id",
      description: "Показать ваш Telegram ID"
    }
  ];

  const groupCommands = [
    {
      command: "connectchat",
      description: "Подключить эту группу"
    },
    {
      command: "disconnectchat",
      description: "Отключить эту группу"
    }
  ];

  const ownerCommands = [
    { command: "start", description: "Панель владельца" },
    { command: "profile", description: "Профиль и использование" },
    { command: "subscription", description: "Состояние подписки" },
    { command: "plans", description: "Доступные тарифы" },
    { command: "paysupport", description: "Поддержка по оплате" },
    { command: "terms", description: "Условия использования и оплаты" },
    { command: "triggers", description: "Персональные триггеры" },
    { command: "addtrigger", description: "Добавить триггер" },
    { command: "removetrigger", description: "Удалить триггер" },
    { command: "sources", description: "Персональные источники" },
    { command: "connectchat", description: "Подключить текущую группу" },
    { command: "disconnectchat", description: "Отключить источник" },
    { command: "users", description: "Пользователи бота" },
    { command: "user", description: "Карточка пользователя" },
    { command: "grant", description: "Выдать подписку" },
    { command: "extend", description: "Продлить подписку" },
    { command: "revoke", description: "Отменить подписку" },
    { command: "blockuser", description: "Отключить аккаунт" },
    { command: "unblockuser", description: "Включить аккаунт" },
    { command: "stats", description: "Статистика лидов" },
    { command: "leads", description: "Активные заявки" },
    { command: "work", description: "Заявки в работе" },
    { command: "lead", description: "Открыть заявку по ID" },
    { command: "archive", description: "Архив заявок" },
    { command: "trash", description: "Удалённые заявки" },
    { command: "restore", description: "Восстановить заявку" },
    { command: "note", description: "Добавить заметку к заявке" },
    { command: "banuser", description: "Забанить пользователя" },
    { command: "unbanuser", description: "Разбанить пользователя" },
    { command: "banlist", description: "Список забаненных" },
    { command: "blackwords", description: "Чёрные слова" },
    { command: "addblackword", description: "Добавить чёрное слово" },
    { command: "removeblackword", description: "Удалить чёрное слово" },
    { command: "chats", description: "Источники" },
    { command: "blockchat", description: "Заблокировать источник" },
    { command: "unblockchat", description: "Разблокировать источник" },
    { command: "id", description: "Показать chat_id и user_id" }
  ];

  try {
    await bot.api.setMyCommands(userCommands, {
      scope: {
        type: "all_private_chats"
      }
    });

    await bot.api.setMyCommands(groupCommands, {
      scope: {
        type: "all_group_chats"
      }
    });

    await bot.api.setMyCommands(ownerCommands, {
      scope: {
        type: "chat",
        chat_id: adminTargetChatId
      }
    });

    console.log("Bot commands menu updated", {
      ownerTelegramUserId,
      adminTargetChatId,
      privateCommands: userCommands.length,
      groupCommands: groupCommands.length,
      ownerCommands: ownerCommands.length
    });
  } catch (error) {
    console.error("BOT_COMMANDS_SETUP_ERROR", error);
  }
}

async function shutdown(): Promise<void> {
  console.log("Shutting down...");

  for (const timer of scheduledHotRefreshes.values()) {
    clearTimeout(timer);
  }

  scheduledHotRefreshes.clear();

  if (paymentExpirySweepTimer) {
    clearInterval(
      paymentExpirySweepTimer
    );

    paymentExpirySweepTimer =
      null;
  }

  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log("Bot is starting...");

await ensureOwnerAccount();
await enforceAllUserPlanLimits();
await expireStalePayments();
startPaymentExpirySweeper();
await setupBotCommands();
await schedulePendingHotLeadRefreshes();

bot.start();
