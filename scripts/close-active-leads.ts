import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, LeadStatus } from "../generated/prisma/client";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL не задан");
}

console.log("DATABASE_URL:", databaseUrl.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@"));

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl })
});

const before = await prisma.lead.findMany({
  where: {
    status: LeadStatus.NEW
  },
  orderBy: {
    lastTriggeredAt: "desc"
  },
  select: {
    id: true,
    authorTelegramId: true,
    authorUsername: true,
    status: true,
    triggerCount: true,
    lastTriggeredAt: true,
    messageText: true
  }
});

console.log(`Активных NEW до закрытия: ${before.length}`);

console.table(before.map((lead) => ({
  id: lead.id,
  authorTelegramId: lead.authorTelegramId,
  username: lead.authorUsername,
  status: lead.status,
  triggerCount: lead.triggerCount,
  lastTriggeredAt: lead.lastTriggeredAt.toISOString(),
  text: lead.messageText.slice(0, 80)
})));

const result = await prisma.lead.updateMany({
  where: {
    status: LeadStatus.NEW
  },
  data: {
    status: LeadStatus.IGNORED
  }
});

console.log(`Закрыто NEW-лидов: ${result.count}`);

const after = await prisma.lead.count({
  where: {
    status: LeadStatus.NEW
  }
});

console.log(`Активных NEW после закрытия: ${after}`);

await prisma.$disconnect();
