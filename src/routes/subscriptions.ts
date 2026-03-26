import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── Plan definitions (static pricing table) ─────────────────────────

interface PlanDefinition {
  id: string;
  name: string;
  plan: 'FREE' | 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE';
  description: string;
  monthlyPrice: number;
  yearlyPrice: number;
  maxUsers: number;
  features: string[];
}

const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    id: 'plan_free',
    name: 'Free',
    plan: 'FREE',
    description: '소규모 팀을 위한 무료 요금제',
    monthlyPrice: 0,
    yearlyPrice: 0,
    maxUsers: 5,
    features: ['기본 근태관리', '직원 관리 (최대 5명)', '기본 대시보드'],
  },
  {
    id: 'plan_starter',
    name: 'Starter',
    plan: 'STARTER',
    description: '성장하는 팀을 위한 스타터 요금제',
    monthlyPrice: 29000,
    yearlyPrice: 290000,
    maxUsers: 25,
    features: ['근태관리', '급여관리', '휴가관리', '직원 관리 (최대 25명)', '기본 리포트'],
  },
  {
    id: 'plan_professional',
    name: 'Professional',
    plan: 'PROFESSIONAL',
    description: '전문 HR 관리를 위한 프로페셔널 요금제',
    monthlyPrice: 79000,
    yearlyPrice: 790000,
    maxUsers: 100,
    features: ['전체 HR 기능', 'OKR/성과관리', '전자계약', 'AI 이상탐지', '고급 리포트', '직원 관리 (최대 100명)'],
  },
  {
    id: 'plan_enterprise',
    name: 'Enterprise',
    plan: 'ENTERPRISE',
    description: '대규모 조직을 위한 엔터프라이즈 요금제',
    monthlyPrice: 199000,
    yearlyPrice: 1990000,
    maxUsers: 9999,
    features: ['전체 HR 기능', 'SSO/MFA', 'API 연동', '전담 지원', '커스텀 리포트', '무제한 직원 관리'],
  },
];

function getPlanDefinition(planId: string): PlanDefinition | undefined {
  return PLAN_DEFINITIONS.find((p) => p.id === planId);
}

function getPlanDefinitionByEnum(plan: string): PlanDefinition | undefined {
  return PLAN_DEFINITIONS.find((p) => p.plan === plan);
}

// ─── Zod Schemas ─────────────────────────────────────────

const createSubscriptionSchema = z.object({
  body: z.object({
    planId: z.string().min(1, 'planId is required'),
    billingCycle: z.enum(['monthly', 'yearly']),
  }),
});

const updateSubscriptionSchema = z.object({
  body: z.object({
    planId: z.string().min(1).optional(),
    billingCycle: z.enum(['monthly', 'yearly']).optional(),
  }).refine((data) => data.planId !== undefined || data.billingCycle !== undefined, {
    message: 'At least one of planId or billingCycle must be provided',
  }),
});

const cancelSubscriptionSchema = z.object({
  body: z.object({
    reason: z.string().optional(),
  }),
});

// ─── Helper functions ────────────────────────────────────

function calculateEndDate(startDate: Date, billingCycle: string): Date {
  const end = new Date(startDate);
  if (billingCycle === 'yearly') {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  return end;
}

function getMonthlyAmount(plan: PlanDefinition, billingCycle: string): number {
  if (billingCycle === 'yearly') {
    return Math.round(plan.yearlyPrice / 12);
  }
  return plan.monthlyPrice;
}

// ─── GET /api/subscriptions/plans ────────────────────────
// 구독 요금제 목록 조회 (공개)

router.get('/plans', async (_req, res: Response, next: NextFunction) => {
  try {
    const plans = PLAN_DEFINITIONS.map((p) => ({
      id: p.id,
      name: p.name,
      plan: p.plan,
      description: p.description,
      monthlyPrice: p.monthlyPrice,
      yearlyPrice: p.yearlyPrice,
      maxUsers: p.maxUsers,
      features: p.features,
    }));

    return res.json({ data: plans });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/subscriptions/current ──────────────────────
// 현재 테넌트의 구독 상태 조회 [인증필요] [역할: admin]

router.get(
  '/current',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;

      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          subscriptionPlan: true,
          subscriptionStatus: true,
          userCount: true,
          maxUsers: true,
        },
      });

      if (!tenant) {
        const error = Object.assign(new Error('Tenant not found'), { status: 404 });
        throw error;
      }

      // Find the active subscription for this tenant
      const subscription = await prisma.subscription.findFirst({
        where: {
          tenantId,
          status: { in: ['ACTIVE', 'TRIAL'] },
        },
        orderBy: { createdAt: 'desc' },
      });

      const planDef = getPlanDefinitionByEnum(tenant.subscriptionPlan);
      const planName = planDef?.name ?? tenant.subscriptionPlan;

      const now = new Date();
      let currentPeriodStart: string;
      let currentPeriodEnd: string;
      let billingCycle: string;
      let monthlyAmount: number;

      if (subscription) {
        currentPeriodStart = subscription.startDate.toISOString();
        currentPeriodEnd = subscription.endDate
          ? subscription.endDate.toISOString()
          : calculateEndDate(subscription.startDate, subscription.billingCycle).toISOString();
        billingCycle = subscription.billingCycle;
        monthlyAmount = subscription.monthlyPrice;
      } else {
        // No subscription record — derive from tenant
        currentPeriodStart = now.toISOString();
        currentPeriodEnd = calculateEndDate(now, 'monthly').toISOString();
        billingCycle = 'monthly';
        monthlyAmount = planDef ? planDef.monthlyPrice : 0;
      }

      return res.json({
        data: {
          planName,
          status: tenant.subscriptionStatus,
          billingCycle,
          currentPeriodStart,
          currentPeriodEnd,
          userCount: tenant.userCount,
          maxUsers: tenant.maxUsers,
          monthlyAmount,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/subscriptions ─────────────────────────────
// 구독 시작 / 요금제 변경 [인증필요] [역할: admin]

router.post(
  '/',
  authenticate,
  authorize('admin'),
  validate(createSubscriptionSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { planId, billingCycle } = req.body as { planId: string; billingCycle: 'monthly' | 'yearly' };

      const planDef = getPlanDefinition(planId);
      if (!planDef) {
        const error = Object.assign(new Error('Invalid plan ID'), { status: 400 });
        throw error;
      }

      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      if (!tenant) {
        const error = Object.assign(new Error('Tenant not found'), { status: 404 });
        throw error;
      }

      // Check if user count exceeds plan max users
      if (tenant.userCount > planDef.maxUsers) {
        const error = Object.assign(
          new Error(`Current user count (${tenant.userCount}) exceeds the maximum allowed (${planDef.maxUsers}) for this plan`),
          { status: 400 },
        );
        throw error;
      }

      // Cancel any existing active subscription
      await prisma.subscription.updateMany({
        where: {
          tenantId,
          status: { in: ['ACTIVE', 'TRIAL'] },
        },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
        },
      });

      const now = new Date();
      const endDate = calculateEndDate(now, billingCycle);
      const monthlyPrice = getMonthlyAmount(planDef, billingCycle);

      // Create new subscription
      const subscription = await prisma.subscription.create({
        data: {
          tenantId,
          plan: planDef.plan,
          status: 'ACTIVE',
          startDate: now,
          endDate,
          monthlyPrice,
          billingCycle,
        },
      });

      // Update tenant
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          subscriptionPlan: planDef.plan,
          subscriptionStatus: 'ACTIVE',
          maxUsers: planDef.maxUsers,
          features: planDef.features,
        },
      });

      return res.status(201).json({
        data: {
          subscriptionId: subscription.id,
          planName: planDef.name,
          status: subscription.status,
          nextBillingDate: endDate.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PUT /api/subscriptions/:subscriptionId ──────────────
// 구독 정보 수정 (업/다운그레이드) [인증필요] [역할: admin]

router.put(
  '/:subscriptionId',
  authenticate,
  authorize('admin'),
  validate(updateSubscriptionSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { subscriptionId } = req.params;
      const { planId, billingCycle } = req.body as { planId?: string; billingCycle?: string };

      const subscription = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
      });

      if (!subscription || subscription.tenantId !== tenantId) {
        const error = Object.assign(new Error('Subscription not found'), { status: 404 });
        throw error;
      }

      if (subscription.status === 'CANCELLED' || subscription.status === 'EXPIRED') {
        const error = Object.assign(
          new Error('Cannot modify a cancelled or expired subscription'),
          { status: 400 },
        );
        throw error;
      }

      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      if (!tenant) {
        const error = Object.assign(new Error('Tenant not found'), { status: 404 });
        throw error;
      }

      // Determine the target plan
      let targetPlanDef: PlanDefinition | undefined;
      if (planId) {
        targetPlanDef = getPlanDefinition(planId);
        if (!targetPlanDef) {
          const error = Object.assign(new Error('Invalid plan ID'), { status: 400 });
          throw error;
        }

        // Check if user count exceeds new plan max users
        if (tenant.userCount > targetPlanDef.maxUsers) {
          const error = Object.assign(
            new Error(`Current user count (${tenant.userCount}) exceeds the maximum allowed (${targetPlanDef.maxUsers}) for this plan`),
            { status: 400 },
          );
          throw error;
        }
      } else {
        targetPlanDef = getPlanDefinitionByEnum(subscription.plan);
      }

      if (!targetPlanDef) {
        const error = Object.assign(new Error('Could not resolve plan definition'), { status: 500 });
        throw error;
      }

      const effectiveBillingCycle = billingCycle ?? subscription.billingCycle;
      const monthlyPrice = getMonthlyAmount(targetPlanDef, effectiveBillingCycle);
      const newEndDate = calculateEndDate(subscription.startDate, effectiveBillingCycle);

      // Update subscription
      const updatedSubscription = await prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
          plan: targetPlanDef.plan,
          billingCycle: effectiveBillingCycle,
          monthlyPrice,
          endDate: newEndDate,
        },
      });

      // Update tenant
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          subscriptionPlan: targetPlanDef.plan,
          maxUsers: targetPlanDef.maxUsers,
          features: targetPlanDef.features,
        },
      });

      return res.json({
        data: {
          subscriptionId: updatedSubscription.id,
          planName: targetPlanDef.name,
          status: updatedSubscription.status,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /api/subscriptions/:subscriptionId ───────────
// 구독 해지 [인증필요] [역할: admin]

router.delete(
  '/:subscriptionId',
  authenticate,
  authorize('admin'),
  validate(cancelSubscriptionSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { subscriptionId } = req.params;
      const { reason } = req.body as { reason?: string };

      const subscription = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
      });

      if (!subscription || subscription.tenantId !== tenantId) {
        const error = Object.assign(new Error('Subscription not found'), { status: 404 });
        throw error;
      }

      if (subscription.status === 'CANCELLED' || subscription.status === 'EXPIRED') {
        const error = Object.assign(
          new Error('Subscription is already cancelled or expired'),
          { status: 400 },
        );
        throw error;
      }

      // The effective date is the end of the current billing period
      const effectiveDate = subscription.endDate
        ? subscription.endDate
        : calculateEndDate(subscription.startDate, subscription.billingCycle);

      const now = new Date();

      // Cancel the subscription
      await prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
        },
      });

      // Update tenant — downgrade to FREE after cancellation
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          subscriptionStatus: 'CANCELLED',
        },
      });

      // Log cancellation reason if provided
      if (reason) {
        await prisma.activityLog.create({
          data: {
            userId: req.user!.userId,
            tenantId,
            action: 'UPDATE',
            resource: 'subscription',
            resourceId: subscriptionId,
            description: `Subscription cancelled. Reason: ${reason}`,
            metadata: { reason, effectiveDate: effectiveDate.toISOString() },
          },
        });
      }

      return res.json({
        data: {
          success: true,
          effectiveDate: effectiveDate.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
