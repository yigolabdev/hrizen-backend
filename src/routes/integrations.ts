import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const updateIntegrationSettingsSchema = z.object({
  body: z.object({
    erpIntegration: z.boolean(),
    groupwareIntegration: z.boolean(),
    financialSystemIntegration: z.boolean(),
  }),
});

// ─── Provider Constants ──────────────────────────────────

const PROVIDER_ERP = 'erp';
const PROVIDER_GROUPWARE = 'groupware';
const PROVIDER_FINANCIAL = 'financial_system';
const ALL_PROVIDERS = [PROVIDER_ERP, PROVIDER_GROUPWARE, PROVIDER_FINANCIAL] as const;

// ─── GET /api/integrations/settings ──────────────────────
// 외부 시스템 연동 설정 조회
router.get(
  '/settings',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;

      const settings = await prisma.integrationSetting.findMany({
        where: {
          tenantId,
          provider: { in: [...ALL_PROVIDERS] },
        },
      });

      const settingsMap = new Map(
        settings.map((s) => [s.provider, s.isEnabled])
      );

      const data = {
        erpIntegration: settingsMap.get(PROVIDER_ERP) ?? false,
        groupwareIntegration: settingsMap.get(PROVIDER_GROUPWARE) ?? false,
        financialSystemIntegration: settingsMap.get(PROVIDER_FINANCIAL) ?? false,
      };

      return res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/integrations/settings ──────────────────────
// 외부 시스템 연동 설정 저장
router.put(
  '/settings',
  authenticate,
  authorize('admin'),
  validate(updateIntegrationSettingsSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { erpIntegration, groupwareIntegration, financialSystemIntegration } = req.body as z.infer<typeof updateIntegrationSettingsSchema>['body'];

      const providerMap: Array<{ provider: string; isEnabled: boolean }> = [
        { provider: PROVIDER_ERP, isEnabled: erpIntegration },
        { provider: PROVIDER_GROUPWARE, isEnabled: groupwareIntegration },
        { provider: PROVIDER_FINANCIAL, isEnabled: financialSystemIntegration },
      ];

      await prisma.$transaction(
        providerMap.map(({ provider, isEnabled }) =>
          prisma.integrationSetting.upsert({
            where: {
              tenantId_provider: {
                tenantId,
                provider,
              },
            },
            create: {
              tenantId,
              provider,
              isEnabled,
              config: {},
            },
            update: {
              isEnabled,
            },
          })
        )
      );

      return res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
