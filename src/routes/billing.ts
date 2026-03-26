import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const createPaymentMethodSchema = z.object({
  body: z.object({
    type: z.enum(['card', 'bank']),
    label: z.string().min(1).max(100),
    number: z.string().min(4),
    expiry: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2,4}$/, 'Expiry must be in MM/YY or MM/YYYY format').optional(),
    isDefault: z.boolean().optional().default(false),
  }),
});

// ─── Helper: mask card/account number to last 4 digits ───

function extractLast4(number: string): string {
  return number.replace(/[\s-]/g, '').slice(-4);
}

function parseExpiry(expiry: string): { month: number; year: number } {
  const [monthStr, yearStr] = expiry.split('/');
  const month = parseInt(monthStr, 10);
  let year = parseInt(yearStr, 10);
  if (year < 100) {
    year += 2000;
  }
  return { month, year };
}

// ─── GET /api/billing/invoices ───────────────────────────
// 청구서(인보이스) 목록 조회 (상태/기간 필터, 페이지네이션)

router.get(
  '/invoices',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);

      // Filters
      const status = req.query.status as string | undefined;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;

      const where: Record<string, unknown> = { tenantId };

      if (status) {
        const validStatuses = ['PENDING', 'PAID', 'OVERDUE', 'CANCELLED', 'REFUNDED'];
        if (validStatuses.includes(status.toUpperCase())) {
          where.status = status.toUpperCase();
        }
      }

      if (startDate || endDate) {
        const issuedAtFilter: Record<string, Date> = {};
        if (startDate) {
          issuedAtFilter.gte = new Date(startDate);
        }
        if (endDate) {
          issuedAtFilter.lte = new Date(endDate);
        }
        where.issuedAt = issuedAtFilter;
      }

      const [data, total] = await Promise.all([
        prisma.invoice.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [sortBy]: sortOrder },
        }),
        prisma.invoice.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/billing/invoices/:invoiceId ────────────────
// 청구서 상세 조회 (항목 포함)

router.get(
  '/invoices/:invoiceId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { invoiceId } = req.params;

      const invoice = await prisma.invoice.findFirst({
        where: {
          id: invoiceId,
          tenantId,
        },
      });

      if (!invoice) {
        throw Object.assign(new Error('Invoice not found'), { status: 404 });
      }

      return res.json({ data: invoice });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/billing/invoices/:invoiceId/download ───────
// 청구서 PDF 다운로드

router.get(
  '/invoices/:invoiceId/download',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { invoiceId } = req.params;

      const invoice = await prisma.invoice.findFirst({
        where: {
          id: invoiceId,
          tenantId,
        },
      });

      if (!invoice) {
        throw Object.assign(new Error('Invoice not found'), { status: 404 });
      }

      if (!invoice.pdfUrl) {
        throw Object.assign(new Error('PDF not available for this invoice'), { status: 404 });
      }

      // If pdfUrl is a local file path, stream it; otherwise redirect
      // For production, this would integrate with a file storage service (S3, etc.)
      // Here we redirect to the stored URL
      return res.redirect(invoice.pdfUrl);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/billing/summary ────────────────────────────
// 결제 현황 요약

router.get(
  '/summary',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;

      // Aggregate invoice data
      const [paidAgg, pendingAgg, overdueAgg, totalInvoices, paidInvoices, activeSubscription] =
        await Promise.all([
          prisma.invoice.aggregate({
            where: { tenantId, status: 'PAID' },
            _sum: { totalAmount: true },
          }),
          prisma.invoice.aggregate({
            where: { tenantId, status: 'PENDING' },
            _sum: { totalAmount: true },
          }),
          prisma.invoice.aggregate({
            where: { tenantId, status: 'OVERDUE' },
            _sum: { totalAmount: true },
          }),
          prisma.invoice.count({
            where: {
              tenantId,
              status: { in: ['PAID', 'PENDING', 'OVERDUE'] },
            },
          }),
          prisma.invoice.count({
            where: { tenantId, status: 'PAID' },
          }),
          prisma.subscription.findFirst({
            where: {
              tenantId,
              status: { in: ['ACTIVE', 'TRIAL'] },
            },
            orderBy: { createdAt: 'desc' },
          }),
        ]);

      const totalPaid = paidAgg._sum.totalAmount ?? 0;
      const pendingAmount = pendingAgg._sum.totalAmount ?? 0;
      const overdueAmount = overdueAgg._sum.totalAmount ?? 0;
      const paymentSuccessRate =
        totalInvoices > 0
          ? Math.round((paidInvoices / totalInvoices) * 10000) / 100
          : 100;

      // Calculate next billing date based on current subscription
      let nextBillingDate: string | null = null;
      let currentPlanName = 'FREE';
      let billingCycle = 'monthly';

      if (activeSubscription) {
        currentPlanName = activeSubscription.plan;
        billingCycle = activeSubscription.billingCycle;
        if (activeSubscription.endDate) {
          nextBillingDate = activeSubscription.endDate.toISOString();
        }
      }

      // If no subscription end date, estimate from latest invoice
      if (!nextBillingDate) {
        const latestInvoice = await prisma.invoice.findFirst({
          where: { tenantId },
          orderBy: { periodEnd: 'desc' },
        });
        if (latestInvoice) {
          const next = new Date(latestInvoice.periodEnd);
          next.setDate(next.getDate() + 1);
          if (billingCycle === 'yearly') {
            next.setFullYear(next.getFullYear() + 1);
          } else {
            next.setMonth(next.getMonth() + 1);
          }
          nextBillingDate = next.toISOString();
        }
      }

      return res.json({
        data: {
          totalPaid,
          pendingAmount,
          overdueAmount,
          nextBillingDate,
          currentPlanName,
          billingCycle,
          paymentSuccessRate,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/billing/payment-methods ────────────────────
// 등록된 결제 수단 목록 조회

router.get(
  '/payment-methods',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;

      const paymentMethods = await prisma.paymentMethod.findMany({
        where: { tenantId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });

      return res.json({ data: paymentMethods });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/billing/payment-methods ───────────────────
// 새 결제 수단 등록

router.post(
  '/payment-methods',
  authenticate,
  authorize('admin'),
  validate(createPaymentMethodSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { type, label, number, expiry, isDefault } = req.body;

      const last4 = extractLast4(number);
      const paymentType = type === 'card' ? 'CREDIT_CARD' : 'BANK_ACCOUNT';

      let expiryMonth: number | undefined;
      let expiryYear: number | undefined;

      if (expiry && type === 'card') {
        const parsed = parseExpiry(expiry);
        expiryMonth = parsed.month;
        expiryYear = parsed.year;
      }

      // If setting as default, unset current default
      if (isDefault) {
        await prisma.paymentMethod.updateMany({
          where: { tenantId, isDefault: true },
          data: { isDefault: false },
        });
      }

      // If this is the first payment method, make it default
      const existingCount = await prisma.paymentMethod.count({ where: { tenantId } });
      const shouldBeDefault = isDefault || existingCount === 0;

      const paymentMethod = await prisma.paymentMethod.create({
        data: {
          tenantId,
          type: paymentType,
          label,
          last4,
          expiryMonth: expiryMonth ?? null,
          expiryYear: expiryYear ?? null,
          bankName: type === 'bank' ? label : null,
          isDefault: shouldBeDefault,
        },
      });

      return res.status(201).json({ data: paymentMethod });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/billing/payment-methods/:methodId/default ──
// 기본 결제 수단 변경

router.put(
  '/payment-methods/:methodId/default',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { methodId } = req.params;

      // Verify the payment method exists and belongs to tenant
      const paymentMethod = await prisma.paymentMethod.findFirst({
        where: { id: methodId, tenantId },
      });

      if (!paymentMethod) {
        throw Object.assign(new Error('Payment method not found'), { status: 404 });
      }

      // Transaction: unset all defaults, then set the target
      await prisma.$transaction([
        prisma.paymentMethod.updateMany({
          where: { tenantId, isDefault: true },
          data: { isDefault: false },
        }),
        prisma.paymentMethod.update({
          where: { id: methodId },
          data: { isDefault: true },
        }),
      ]);

      return res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/billing/payment-methods/:methodId ───────
// 결제 수단 삭제

router.delete(
  '/payment-methods/:methodId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { methodId } = req.params;

      const paymentMethod = await prisma.paymentMethod.findFirst({
        where: { id: methodId, tenantId },
      });

      if (!paymentMethod) {
        throw Object.assign(new Error('Payment method not found'), { status: 404 });
      }

      const wasDefault = paymentMethod.isDefault;

      await prisma.paymentMethod.delete({
        where: { id: methodId },
      });

      // If the deleted method was default, assign default to the most recent remaining one
      if (wasDefault) {
        const nextDefault = await prisma.paymentMethod.findFirst({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
        });

        if (nextDefault) {
          await prisma.paymentMethod.update({
            where: { id: nextDefault.id },
            data: { isDefault: true },
          });
        }
      }

      return res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
