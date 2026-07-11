export type LeadDetectionResult = {
  score: number;
  matched: string[];
  negativeMatched: string[];
  category: "site" | "landing" | "shop" | "support" | "unknown";
};

type LeadCategory = LeadDetectionResult["category"];

type SignalRule = {
  label: string;
  score: number;
  pattern: RegExp;
  category?: LeadCategory;
  kind:
    | "intent"
    | "recommendation"
    | "service"
    | "developer"
    | "action"
    | "support-action"
    | "context"
    | "commercial"
    | "urgency";
};

type NegativeRule = {
  label: string;
  score: number;
  pattern: RegExp;
};

type MatchedSignal = SignalRule & {
  matchedText: string;
};

type RegexFlags = "i" | "iu";

const WORD_LEFT = String.raw`(?<![\p{L}\p{N}_])`;
const WORD_RIGHT = String.raw`(?![\p{L}\p{N}_])`;

function rx(source: string, flags: RegexFlags = "iu"): RegExp {
  return new RegExp(source, flags);
}

function word(source: string): RegExp {
  return rx(`${WORD_LEFT}(?:${source})${WORD_RIGHT}`);
}

const signalRules: SignalRule[] = [
  // Намерение
  {
    label: "хочу",
    score: 1,
    pattern: word("хочу"),
    kind: "intent"
  },
  {
    label: "нужен / надо / требуется",
    score: 1,
    pattern: word("нужен|нужна|нужно|надо|требуется|интересует"),
    kind: "intent"
  },
  {
    label: "ищу",
    score: 1,
    pattern: word("ищу"),
    kind: "intent"
  },
  {
    label: "кто может сделать",
    score: 2,
    pattern: word(String.raw`кто\s+(?:может|сможет)\s+(?:сделать|создать|разработать|собрать|доработать)`),
    kind: "recommendation"
  },
  {
    label: "кто знает специалиста",
    score: 2,
    pattern: word(String.raw`кто\s+знает\s+(?:человека|специалиста|разработчика|веб[-\s]?разработчика|дизайнера)`),
    kind: "recommendation"
  },
  {
    label: "посоветуйте специалиста",
    score: 2,
    pattern: word(String.raw`(?:посоветуйте|подскажите)\s+(?:человека|специалиста|разработчика|веб[-\s]?разработчика|дизайнера|кто)`),
    kind: "recommendation"
  },

  // Объект заявки
  {
    label: "сайт",
    score: 2,
    pattern: word("сайт(?:а|ов|ы|ом|е)?"),
    category: "site",
    kind: "service"
  },
  {
    label: "лендинг",
    score: 2,
    pattern: word(String.raw`(?:лендинг(?:а|и|ом|е)?|landing\s?page)`),
    category: "landing",
    kind: "service"
  },
  {
    label: "интернет-магазин",
    score: 3,
    pattern: word(String.raw`(?:интернет[-\s]?магазин(?:а|ы|ом|е)?|e-?commerce|онлайн[-\s]?магазин)`),
    category: "shop",
    kind: "service"
  },
  {
    label: "веб-система / админка",
    score: 3,
    pattern: word(String.raw`(?:веб[-\s]?систем[ауые]?|web[-\s]?систем[ауые]?|админк[ауи]?|личный кабинет|crm)`),
    category: "site",
    kind: "service"
  },
  {
    label: "разработчик",
    score: 2,
    pattern: word(String.raw`(?:разработчик(?:а|ов|у|ом)?|веб[-\s]?разработчик(?:а|ов|у|ом)?|web[-\s]?developer)`),
    category: "unknown",
    kind: "developer"
  },

  // Действие
  {
    label: "сделать / создать / разработать",
    score: 1,
    pattern: word("сделать|создать|разработать|собрать|запустить"),
    kind: "action"
  },
  {
    label: "доработать / переделать",
    score: 2,
    pattern: word("доработать|переделать|обновить|починить|исправить|допилить"),
    category: "support",
    kind: "support-action"
  },

  // Контекст
  {
    label: "есть ниша / назначение",
    score: 2,
    pattern: rx(String.raw`${WORD_LEFT}(?:для|под)\s+[\p{L}\p{N}\s-]{3,70}`),
    kind: "context"
  },
  {
    label: "бизнес / компания / услуга",
    score: 1,
    pattern: word("бизнес(?:а)?|компани[яию]|услуг[аи]?|проект(?:а)?|бренд(?:а)?|продаж(?:и|у)?"),
    kind: "commercial"
  },
  {
    label: "конкретная ниша",
    score: 1,
    pattern: word("салон(?:а)? красоты|барбершоп(?:а)?|студи[яию]|клиник[ауы]?|кафе|ресторан(?:а)?|магазин(?:а)?|школ[ауы]?|курс(?:а)?|доставк[ауы]?|сервис(?:а)?"),
    kind: "commercial"
  },

  // Усилители
  {
    label: "срочность",
    score: 1,
    pattern: word("срочно|быстро|как можно быстрее|горит|на этой неделе"),
    kind: "urgency"
  },
  {
    label: "бюджет / цена / оплата",
    score: 1,
    pattern: word("бюджет|цена|стоимость|сколько стоит|оплата|заплачу|готов(?:ы)? оплатить"),
    kind: "urgency"
  },
  {
    label: "Next.js / React",
    score: 1,
    pattern: word(String.raw`(?:next\.?js|react|typescript|node\.?js)`),
    category: "site",
    kind: "urgency"
  }
];

const negativeRules: NegativeRule[] = [
  {
    label: "ищу работу",
    score: -6,
    pattern: word("ищу работу|ищу вакансию|рассматриваю вакансии|откликнуться на вакансию")
  },
  {
    label: "резюме / портфолио разработчика",
    score: -5,
    pattern: word("резюме|cv|портфолио разработчика|мое портфолио")
  },
  {
    label: "обучение / курс",
    score: -3,
    pattern: word("курс|обучение|учусь|урок|туториал|как научиться")
  },
  {
    label: "как сделать сайт",
    score: -4,
    pattern: word(String.raw`как\s+(?:самому\s+)?(?:сделать|создать|разработать)\s+сайт`)
  },
  {
    label: "сам сделал сайт",
    score: -3,
    pattern: word("сам сделал сайт|сама сделала сайт|сами сделали сайт|я сделал сайт")
  },
  {
    label: "не нужен сайт",
    score: -6,
    pattern: word("не нужен сайт|сайт не нужен|без сайта|не надо сайт")
  }
];

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}.+#\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueByLabel<T extends { label: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    result.push(item);
  }

  return result;
}

function findSignals(text: string): MatchedSignal[] {
  const normalized = normalizeText(text);

  const matches = signalRules.flatMap((rule) => {
    const match = normalized.match(rule.pattern);

    if (!match) return [];

    return [
      {
        ...rule,
        matchedText: match[0]
      }
    ];
  });

  return uniqueByLabel(matches);
}

function findNegativeSignals(text: string): NegativeRule[] {
  const normalized = normalizeText(text);
  return uniqueByLabel(negativeRules.filter((rule) => rule.pattern.test(normalized)));
}

function pickCategory(matches: MatchedSignal[]): LeadCategory {
  const hasSupportAction = matches.some((match) => match.kind === "support-action");
  const hasDigitalObject = matches.some((match) => match.kind === "service");

  if (hasSupportAction && hasDigitalObject) {
    return "support";
  }

  const weighted = new Map<LeadCategory, number>();

  for (const match of matches) {
    if (!match.category || match.category === "unknown") continue;
    weighted.set(match.category, (weighted.get(match.category) ?? 0) + match.score);
  }

  let best: LeadCategory = "unknown";
  let bestScore = 0;

  for (const [category, score] of weighted.entries()) {
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }

  return best;
}

function calculateScore(matches: MatchedSignal[], negativeMatches: NegativeRule[]): number {
  const positiveScore = matches.reduce((sum, match) => sum + match.score, 0);
  const negativeScore = negativeMatches.reduce((sum, match) => sum + match.score, 0);

  const hasIntent = matches.some((match) =>
    ["intent", "recommendation"].includes(match.kind)
  );

  const hasObject = matches.some((match) =>
    ["service", "developer"].includes(match.kind)
  );

  const hasAction = matches.some((match) =>
    ["action", "support-action"].includes(match.kind)
  );

  const comboBonus =
    hasIntent && hasObject && hasAction
      ? 1
      : hasIntent && hasObject
        ? 0.5
        : 0;

  const rawScore = positiveScore + negativeScore + comboBonus;

  return Math.max(0, Math.min(10, Math.round(rawScore)));
}

export function detectLead(text: string, minScore: number): LeadDetectionResult | null {
  const normalized = normalizeText(text);

  if (!normalized) return null;

  const matches = findSignals(normalized);
  const negativeMatches = findNegativeSignals(normalized);

  const hasServiceOrDeveloper = matches.some((match) =>
    ["service", "developer"].includes(match.kind)
  );

  if (!hasServiceOrDeveloper) return null;

  const score = calculateScore(matches, negativeMatches);

  if (score < minScore) return null;

  return {
    score,
    matched: matches.map((match) => match.label),
    negativeMatched: negativeMatches.map((match) => match.label),
    category: pickCategory(matches)
  };
}
