import path from 'node:path';
import type { PrismaConfig } from 'prisma';

export default {
  earlyAccess: true,
  schema: path.join('prisma', 'schema.prisma'),

  migrate: {
    async url() {
      return process.env.DATABASE_URL ?? 'postgresql://localhost:5432/hrizen';
    },
  },
} satisfies PrismaConfig;
