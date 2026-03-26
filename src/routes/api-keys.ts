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

      const { raw, prefix, hash } = generateApiKey();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);

      const apiKey = await prisma.apiKey.create({
        data: {
          tenantId,
          name,
          key: hash,
          prefix,
          expiresAt,
          isActive: true,
          requestCount: 0,
        },
      });

      return res.status(201).json({
        data: {
          id: apiKey.id,
          name: apiKey.name,
          apiKey: raw,
          prefix: apiKey.prefix,
          expiresAt: apiKey.expiresAt?.toISOString() ?? null,
          createdAt: apiKey.createdAt.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/api-keys/:keyId — API 키 비활성화 ───────

router.delete(
  '/:keyId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const keyId = req.params.keyId as string;

      await prisma.apiKey.updateMany({
        where: {
          id: keyId,
          tenantId,
        },
        data: {
          isActive: false,
        },
      });

      return res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/api-keys/:keyId/usage — API 키 사용량 조회 ─

router.get(
  '/:keyId/usage',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const keyId = req.params.keyId as string;

      const apiKey = await prisma.apiKey.findFirst({
        where: {
          id: keyId,
          tenantId,
        },
      });

      if (!apiKey) {
        throw Object.assign(new Error('API key not found'), { status: 404 });
      }

      return res.json({
        data: {
          id: apiKey.id,
          name: apiKey.name,
          requestCount: apiKey.requestCount,
          lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
