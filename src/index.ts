import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import {
  LeadCategory,
  LeadDeliveryType,
  LeadStatus,
  PrismaClient,
  SubscriptionStatus,
  UserRole
} from "../generated/prisma/client";
import { detectLead, type LeadDetectionResult } from "./lead-detector";

const token = process.env.BOT_TOKEN?.trim();
const adminChatId = process.env.ADMIN_CHAT_ID?.trim();
const ownerTelegramId = process.env.OWNER_TELEGRAM_ID?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();

const minLeadScore = Number(process.env.MIN_LEAD_SCORE ?? 3);
const hotLeadMinutes = Number(process.env.HOT_LEAD_MINUTES ?? 30);
const spamWindowMinutes = Number(process.env.SPAM_WINDOW_MINUTES ?? 15);
const spamMaxTriggers = Number(process.env.SPAM_MAX_TRIGGERS ?? 10);
const trialDays = Number(process.env.TRIAL_DAYS ?? 7);

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

const adapter = new PrismaPg({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter });
const bot = new Bot(token);

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
      role: isOwner ? UserRole.OWNER : UserRole.USER,
      isActive: true
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
    const { subscription } = registration;

    await ctx.reply(
      [
        "👋 Добро пожаловать!",
        "",
        "Ваш аккаунт зарегистрирован.",
        "",
        `Тариф: ${subscription.planCode}`,
        `Статус: ${subscription.status}`,
        `Доступ до: ${formatAccessDate(subscription.expiresAt)}`,
        "",
        "Доступные команды:",
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
      "/triggers — персональные триггеры",
      "/addtrigger фраза — добавить триггер",
      "/removetrigger фраза — удалить триггер",
      "/users — пользователи бота",
      "/user telegram_id — карточка пользователя",
      "/grant telegram_id дни — выдать подписку",
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
        id: true
      }
    });

  if (!existingTrigger) {
    const triggerCount =
      await prisma.userTrigger.count({
        where: {
          userId: user.id
        }
      });

    if (triggerCount >= 20) {
      await ctx.reply(
        "Достигнут лимит: максимум 20 триггеров."
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
      getSubscriptionStatusLabel(
        subscription?.status ?? null
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
        getSubscriptionStatusLabel(
          subscription?.status ?? null
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

  const [, telegramId, rawDays] =
    (ctx.message?.text ?? "")
      .trim()
      .split(/\s+/);

  const days = parseSubscriptionDays(rawDays);

  if (!telegramId || !days) {
    await ctx.reply(
      [
        "Формат:",
        "/grant telegram_id количество_дней",
        "",
        "Пример:",
        "/grant 123456789 30",
        "",
        "Допустимо от 1 до 3650 дней."
      ].join("\n")
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
      "Подписка владельца бессрочная и не изменяется."
    );
    return;
  }

  const now = new Date();
  const expiresAt = addDaysToDate(now, days);

  await prisma.subscription.upsert({
    where: {
      userId: user.id
    },
    update: {
      planCode: "MANUAL",
      status: SubscriptionStatus.ACTIVE,
      startsAt: now,
      expiresAt,
      autoRenew: false
    },
    create: {
      userId: user.id,
      planCode: "MANUAL",
      status: SubscriptionStatus.ACTIVE,
      startsAt: now,
      expiresAt,
      autoRenew: false
    }
  });

  await ctx.reply(
    [
      "✅ Подписка выдана.",
      "",
      `Пользователь: ${getBotUserDisplayName(user)}`,
      `Telegram ID: ${user.telegramId}`,
      `Срок: ${days} дн.`,
      `Доступ до: ${formatAccessDate(expiresAt)}`
    ].join("\n")
  );

  await notifyBotUser(
    user.deliveryChatId,
    [
      "✅ Ваша подписка активирована.",
      `Срок: ${days} дн.`,
      `Доступ до: ${formatAccessDate(expiresAt)}`
    ].join("\n")
  );
});

bot.command("extend", async (ctx) => {
  if (!assertAdmin(ctx)) return;

  const [, telegramId, rawDays] =
    (ctx.message?.text ?? "")
      .trim()
      .split(/\s+/);

  const days = parseSubscriptionDays(rawDays);

  if (!telegramId || !days) {
    await ctx.reply(
      [
        "Формат:",
        "/extend telegram_id количество_дней",
        "",
        "Пример:",
        "/extend 123456789 7"
      ].join("\n")
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
      "Подписка владельца бессрочная и не изменяется."
    );
    return;
  }

  const now = new Date();
  const currentExpiresAt =
    user.subscription?.expiresAt;

  const baseDate =
    currentExpiresAt &&
    currentExpiresAt.getTime() > now.getTime()
      ? currentExpiresAt
      : now;

  const expiresAt = addDaysToDate(
    baseDate,
    days
  );

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
      planCode: "MANUAL",
      status: SubscriptionStatus.ACTIVE,
      startsAt: now,
      expiresAt,
      autoRenew: false
    }
  });

  await ctx.reply(
    [
      "✅ Подписка продлена.",
      "",
      `Пользователь: ${getBotUserDisplayName(user)}`,
      `Добавлено: ${days} дн.`,
      `Доступ до: ${formatAccessDate(expiresAt)}`
    ].join("\n")
  );

  await notifyBotUser(
    user.deliveryChatId,
    [
      "✅ Ваша подписка продлена.",
      `Добавлено: ${days} дн.`,
      `Доступ до: ${formatAccessDate(expiresAt)}`
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

bot.callbackQuery("triggers:list", async (ctx) => {
  const user = await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.answerCallbackQuery({
      text: "Сначала выполните /start"
    });
    return;
  }

  await ctx.answerCallbackQuery({
    text: "Триггеры обновлены"
  });

  await editUserTriggersMessage(ctx, user.id);
});

bot.callbackQuery("triggers:add", async (ctx) => {
  const user = await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.answerCallbackQuery({
      text: "Сначала выполните /start"
    });
    return;
  }

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
  const user = await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.answerCallbackQuery({
      text: "Сначала выполните /start"
    });
    return;
  }

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
  const user = await getCurrentBotUser(ctx);

  if (!user) {
    await ctx.answerCallbackQuery({
      text: "Сначала выполните /start"
    });
    return;
  }

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

  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log("Bot is starting...");

await ensureOwnerAccount();
await setupBotCommands();
await schedulePendingHotLeadRefreshes();

bot.start();
