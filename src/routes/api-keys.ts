import { Router, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const createApiKeySchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).default('Default API Key'),
    expiresInDays: z.number().int().min(1).max(365).optional().default(90),
  }),
});

const usageQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

// ─── Helpers ─────────────────────────────────────────────

function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `hrz_${crypto.randomBytes(32).toString('hex')}`;
  const prefix = raw.slice(0, 12);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, prefix, hash };
}

// ─── GET /api/api-keys — 현재 테넌트의 API 키 목록 조회 ───

router.get(
  '/',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);

      const where = {
        tenantId,
        isActive: true,
      };

      const [data, total] = await Promise.all([
        prisma.apiKey.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [sortBy]: sortOrder },
          select: {
            id: true,
            name: true,
            prefix: true,
            lastUsedAt: true,
            expiresAt: true,
            isActive: true,
            requestCount: true,
            createdAt: true,
          },
        }),
        prisma.apiKey.count({ where }),
      ]);

      const mapped = data.map((key) => ({
        id: key.id,
        name: key.name,
        apiKey: `${key.prefix}${'*'.repeat(40)}`,
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        expiresAt: key.expiresAt?.toISOString() ?? null,
        isActive: key.isActive,
        requestCount: key.requestCount,
        createdAt: key.createdAt.toISOString(),
      }));

      return res.json(paginatedResponse(mapped, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/api-keys — 새 API 키 발급 (기존 키 무효화) ───

router.post(
  '/',
  authenticate,
  authorize('admin'),
  validate(createApiKeySchema),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { name, expiresInDays } = req.body as { name: string; expiresInDays: number };

      // 기존 활성 키 모두 무효화
      await prisma.apiKey.updateMany({
        where: {
          tenantId,
          isActive: true,
        },
        data: {
          isActive: false,
        },
      });

      // 새 키 생성
      const { raw, prefix, hash } = generateApiKey();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);

      const apiKey = await prisma.apiKey.create({
        data: {
          name,
          keyHash: hash,
          prefix,
          expiresAt,
          isActive: true,
          tenantId,
        },
        select: {
          id: true,
          name: true,
          prefix: true,
          expiresAt: true,
          createdAt: true,
        },
      });

      return res.status(201).json({
        data: {
          id: apiKey.id,
          name: apiKey.name,
          apiKey: raw,
          createdAt: apiKey.createdAt.toISOString(),
          expiresAt: apiKey.expiresAt?.toISOString() ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/api-keys/:keyId — API 키 폐기 ───────────

router.delete(
  '/:keyId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { keyId } = req.params;

      const existing = await prisma.apiKey.findFirst({
        where: {
          id: keyId,
          tenantId,
        },
      });

      if (!existing) {
        const error = Object.assign(new Error('API key not found'), { status: 404 });
        throw error;
      }

      await prisma.apiKey.update({
        where: { id: keyId },
        data: { isActive: false },
      });

      return res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/api-keys/usage — API 사용량 통계 조회 ──────

router.get(
  '/usage',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;

      const parsed = usageQuerySchema.safeParse(req.query);
      const startDate = parsed.success && parsed.data.startDate
        ? new Date(parsed.data.startDate)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = parsed.success && parsed.data.endDate
        ? new Date(parsed.data.endDate)
        : new Date();

      // 해당 테넌트의 활성/비활성 모든 키 ID 조회
      const tenantApiKeys = await prisma.apiKey.findMany({
        where: { tenantId },
        select: { id: true },
      });

      const apiKeyIds = tenantApiKeys.map((k) => k.id);

      if (apiKeyIds.length === 0) {
        return res.json({ data: [] });
      }

      // 일별 사용량 집계 (raw query for date grouping)
      const usageLogs = await prisma.apiUsageLog.findMany({
        where: {
          apiKeyId: { in: apiKeyIds },
          calledAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        select: {
          calledAt: true,
        },
        orderBy: {
          calledAt: 'asc',
        },
      });

      // 일별로 그룹핑
      const dailyCounts = new Map<string, number>();
      for (const log of usageLogs) {
        const dateStr = log.calledAt.toISOString().split('T')[0];
        dailyCounts.set(dateStr, (dailyCounts.get(dateStr) ?? 0) + 1);
      }

      // 시작일부터 종료일까지 모든 날짜를 채움 (0 포함)
      const result: { date: string; count: number }[] = [];
      const current = new Date(startDate);
      current.setUTCHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);

      while (current <= end) {
        const dateStr = current.toISOString().split('T')[0];
        result.push({
          date: dateStr,
          count: dailyCounts.get(dateStr) ?? 0,
        });
        current.setDate(current.getDate() + 1);
      }

      return res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
