import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const createTenantSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    country: z.string().min(1).max(100),
    language: z.string().min(1).max(10),
    currency: z.string().min(1).max(10),
    timezone: z.string().min(1).max(100),
    businessType: z.string().min(1).max(100),
    adminEmail: z.string().email(),
    maxUsers: z.number().int().positive(),
    subscriptionPlan: z.enum(['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE']),
    features: z.array(z.string()),
    ssoEnabled: z.boolean(),
    mfaRequired: z.boolean(),
  }),
});

const updateTenantSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    country: z.string().min(1).max(100).optional(),
    language: z.string().min(1).max(10).optional(),
    currency: z.string().min(1).max(10).optional(),
    timezone: z.string().min(1).max(100).optional(),
    businessType: z.string().min(1).max(100).optional(),
    adminEmail: z.string().email().optional(),
    maxUsers: z.number().int().positive().optional(),
    subscriptionPlan: z.enum(['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE']).optional(),
    features: z.array(z.string()).optional(),
    ssoEnabled: z.boolean().optional(),
    mfaRequired: z.boolean().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  }),
});

// ─── Plan pricing map for MRR calculation ────────────────

const PLAN_MONTHLY_PRICE: Record<string, number> = {
  FREE: 0,
  STARTER: 49000,
  PROFESSIONAL: 149000,
  ENTERPRISE: 499000,
};

// ─── GET /api/tenants — 멀티테넌트 목록 조회 ─────────────

router.get(
  '/',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);

      const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
      const subscriptionPlan = typeof req.query.subscriptionPlan === 'string' ? req.query.subscriptionPlan : undefined;
      const subscriptionStatus = typeof req.query.subscriptionStatus === 'string' ? req.query.subscriptionStatus : undefined;

      const where: Record<string, unknown> = {
        deletedAt: null,
      };

      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { adminEmail: { contains: search, mode: 'insensitive' } },
          { businessType: { contains: search, mode: 'insensitive' } },
        ];
      }

      if (subscriptionPlan) {
        where.subscriptionPlan = subscriptionPlan;
      }

      if (subscriptionStatus) {
        where.subscriptionStatus = subscriptionStatus;
      }

      const [data, total] = await Promise.all([
        prisma.tenant.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [sortBy]: sortOrder },
        }),
        prisma.tenant.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/tenants/summary — 테넌트 구독 현황 요약 ────

router.get(
  '/summary',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const baseWhere = { deletedAt: null };

      const [
        totalTenants,
        activeTenants,
        trialTenants,
        expiredTenants,
        userAgg,
        activeTenantsForRevenue,
      ] = await Promise.all([
        prisma.tenant.count({ where: baseWhere }),
        prisma.tenant.count({ where: { ...baseWhere, subscriptionStatus: 'ACTIVE' } }),
        prisma.tenant.count({ where: { ...baseWhere, subscriptionStatus: 'TRIAL' } }),
        prisma.tenant.count({ where: { ...baseWhere, subscriptionStatus: 'EXPIRED' } }),
        prisma.tenant.aggregate({
          where: baseWhere,
          _sum: { userCount: true },
        }),
        prisma.tenant.findMany({
          where: { ...baseWhere, subscriptionStatus: 'ACTIVE' },
          select: { subscriptionPlan: true },
        }),
      ]);

      const totalUsers = userAgg._sum.userCount ?? 0;

      const totalRevenue = activeTenantsForRevenue.reduce((sum, tenant) => {
        return sum + (PLAN_MONTHLY_PRICE[tenant.subscriptionPlan] ?? 0);
      }, 0);

      return res.json({
        data: {
          totalTenants,
          activeTenants,
          trialTenants,
          expiredTenants,
          totalUsers,
          totalRevenue,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/tenants/:tenantId — 특정 테넌트 상세 조회 ──

router.get(
  '/:tenantId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = req.params;

      const tenant = await prisma.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        include: {
          subscriptions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          _count: {
            select: {
              users: true,
              employees: true,
              departments: true,
            },
          },
        },
      });

      if (!tenant) {
        throw Object.assign(new Error('Tenant not found'), { status: 404 });
      }

      return res.json({ data: tenant });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/tenants — 새 테넌트 생성 ─────────────────

router.post(
  '/',
  authenticate,
  authorize('admin'),
  validate(createTenantSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const {
        name,
        country,
        language,
        currency,
        timezone,
        businessType,
        adminEmail,
        maxUsers,
        subscriptionPlan,
        features,
        ssoEnabled,
        mfaRequired,
      } = req.body;

      const tenant = await prisma.tenant.create({
        data: {
          name,
          country,
          language,
          currency,
          timezone,
          businessType,
          adminEmail,
          maxUsers,
          subscriptionPlan,
          subscriptionStatus: 'TRIAL',
          features,
          ssoEnabled,
          mfaRequired,
        },
      });

      return res.status(201).json({ data: tenant });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/tenants/:tenantId — 테넌트 정보 수정 ──────

router.put(
  '/:tenantId',
  authenticate,
  authorize('admin'),
  validate(updateTenantSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = req.params;

      const existing = await prisma.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
      });

      if (!existing) {
        throw Object.assign(new Error('Tenant not found'), { status: 404 });
      }

      const {
        name,
        country,
        language,
        currency,
        timezone,
        businessType,
        adminEmail,
        maxUsers,
        subscriptionPlan,
        features,
        ssoEnabled,
        mfaRequired,
      } = req.body;

      const tenant = await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          ...(name !== undefined && { name }),
          ...(country !== undefined && { country }),
          ...(language !== undefined && { language }),
          ...(currency !== undefined && { currency }),
          ...(timezone !== undefined && { timezone }),
          ...(businessType !== undefined && { businessType }),
          ...(adminEmail !== undefined && { adminEmail }),
          ...(maxUsers !== undefined && { maxUsers }),
          ...(subscriptionPlan !== undefined && { subscriptionPlan }),
          ...(features !== undefined && { features }),
          ...(ssoEnabled !== undefined && { ssoEnabled }),
          ...(mfaRequired !== undefined && { mfaRequired }),
        },
      });

      return res.json({ data: tenant });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/tenants/:tenantId — 테넌트 삭제 (소프트) ─

router.delete(
  '/:tenantId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = req.params;

      const existing = await prisma.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
      });

      if (!existing) {
        throw Object.assign(new Error('Tenant not found'), { status: 404 });
      }

      await prisma.tenant.update({
        where: { id: tenantId },
        data: { deletedAt: new Date() },
      });

      return res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
