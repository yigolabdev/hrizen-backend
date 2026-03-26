import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const keyResultSchema = z.object({
  title: z.string().min(1, 'Key result title is required'),
  target: z.number().positive('Target must be a positive number'),
  unit: z.string().min(1, 'Unit is required'),
});

const objectiveSchema = z.object({
  title: z.string().min(1, 'Objective title is required'),
  keyResults: z.array(keyResultSchema).min(1, 'At least one key result is required'),
});

const createOkrSchema = z.object({
  body: z.object({
    employeeId: z.string().min(1, 'Employee ID is required'),
    quarter: z.string().min(1, 'Quarter is required'),
    objectives: z.array(objectiveSchema).min(1, 'At least one objective is required'),
  }),
});

const updateOkrSchema = z.object({
  body: z.object({
    objectives: z.array(z.record(z.unknown())).optional(),
    status: z.enum(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
    overallProgress: z.number().min(0).max(100).optional(),
  }).refine(
    (data) => data.objectives !== undefined || data.status !== undefined || data.overallProgress !== undefined,
    { message: 'At least one field (objectives, status, overallProgress) must be provided' }
  ),
});

const createReviewSchema = z.object({
  body: z.object({
    employeeId: z.string().min(1, 'Employee ID is required'),
    reviewerId: z.string().min(1, 'Reviewer ID is required'),
    period: z.string().min(1, 'Period is required'),
    scores: z.record(z.unknown()),
    feedback: z.string().min(1, 'Feedback is required'),
  }),
});

const updateReviewSchema = z.object({
  body: z.object({
    scores: z.record(z.unknown()).optional(),
    feedback: z.string().min(1).optional(),
    status: z.enum(['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'COMPLETED']).optional(),
  }).refine(
    (data) => data.scores !== undefined || data.feedback !== undefined || data.status !== undefined,
    { message: 'At least one field (scores, feedback, status) must be provided' }
  ),
});

// ─── OKR Routes ──────────────────────────────────────────

// GET /api/performance/okrs — OKR 목록 조회
router.get(
  '/okrs',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);
      const tenantId = req.user!.tenantId;

      const departmentFilter = req.query.department as string | undefined;
      const employeeIdFilter = req.query.employeeId as string | undefined;
      const quarterFilter = req.query.quarter as string | undefined;
      const statusFilter = req.query.status as string | undefined;

      const where: Record<string, unknown> = { tenantId };

      if (employeeIdFilter) {
        where.employeeId = employeeIdFilter;
      }

      if (quarterFilter) {
        where.quarter = quarterFilter;
      }

      if (statusFilter) {
        where.status = statusFilter;
      }

      if (departmentFilter) {
        where.employee = { department: departmentFilter };
      }

      const validSortFields = ['createdAt', 'updatedAt', 'quarter', 'overallProgress', 'status'];
      const orderByField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

      const [data, total] = await Promise.all([
        prisma.oKR.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [orderByField]: sortOrder },
          include: {
            employee: {
              select: {
                id: true,
                name: true,
                employeeNumber: true,
                department: true,
                position: true,
              },
            },
          },
        }),
        prisma.oKR.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/performance/okrs — OKR 생성
router.post(
  '/okrs',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(createOkrSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId, quarter, objectives } = req.body;

      // 직원 존재 여부 및 테넌트 확인
      const employee = await prisma.employee.findFirst({
        where: { id: employeeId, tenantId, deletedAt: null },
      });

      if (!employee) {
        throw Object.assign(new Error('Employee not found'), { status: 404 });
      }

      // 중복 OKR 확인 (같은 직원, 같은 분기)
      const existingOkr = await prisma.oKR.findFirst({
        where: { employeeId, quarter, tenantId },
      });

      if (existingOkr) {
        throw Object.assign(
          new Error(`OKR already exists for employee in quarter ${quarter}`),
          { status: 409 }
        );
      }

      const okr = await prisma.oKR.create({
        data: {
          employeeId,
          quarter,
          objectives: objectives as unknown as Record<string, unknown>[],
          overallProgress: 0,
          status: 'IN_PROGRESS',
          tenantId,
        },
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              employeeNumber: true,
              department: true,
              position: true,
            },
          },
        },
      });

      return res.status(201).json({ data: okr });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/performance/okrs/:okrId — OKR 수정
router.put(
  '/okrs/:okrId',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(updateOkrSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { okrId } = req.params;
      const { objectives, status, overallProgress } = req.body;

      const existingOkr = await prisma.oKR.findFirst({
        where: { id: okrId, tenantId },
      });

      if (!existingOkr) {
        throw Object.assign(new Error('OKR not found'), { status: 404 });
      }

      const updateData: Record<string, unknown> = {};

      if (objectives !== undefined) {
        updateData.objectives = objectives;
      }

      if (status !== undefined) {
        updateData.status = status;
      }

      if (overallProgress !== undefined) {
        updateData.overallProgress = overallProgress;
      }

      const okr = await prisma.oKR.update({
        where: { id: okrId },
        data: updateData,
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              employeeNumber: true,
              department: true,
              position: true,
            },
          },
        },
      });

      return res.json({ data: okr });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/performance/okrs/:okrId — OKR 삭제
router.delete(
  '/okrs/:okrId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { okrId } = req.params;

      const existingOkr = await prisma.oKR.findFirst({
        where: { id: okrId, tenantId },
      });

      if (!existingOkr) {
        throw Object.assign(new Error('OKR not found'), { status: 404 });
      }

      await prisma.oKR.delete({
        where: { id: okrId },
      });

      return res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

// ─── Performance Review Routes ───────────────────────────

// GET /api/performance/reviews — 성과 평가 목록 조회
router.get(
  '/reviews',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);
      const tenantId = req.user!.tenantId;

      const employeeIdFilter = req.query.employeeId as string | undefined;
      const periodFilter = req.query.period as string | undefined;
      const statusFilter = req.query.status as string | undefined;

      const where: Record<string, unknown> = { tenantId };

      if (employeeIdFilter) {
        where.employeeId = employeeIdFilter;
      }

      if (periodFilter) {
        where.reviewPeriod = periodFilter;
      }

      if (statusFilter) {
        where.status = statusFilter;
      }

      const validSortFields = ['createdAt', 'updatedAt', 'reviewPeriod', 'overallScore', 'status', 'completedAt'];
      const orderByField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

      const [data, total] = await Promise.all([
        prisma.performanceReview.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [orderByField]: sortOrder },
          include: {
            employee: {
              select: {
                id: true,
                name: true,
                employeeNumber: true,
                department: true,
                position: true,
              },
            },
          },
        }),
        prisma.performanceReview.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/performance/reviews — 성과 평가 생성
router.post(
  '/reviews',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(createReviewSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId, reviewerId, period, scores, feedback } = req.body;

      // 직원 존재 여부 확인
      const employee = await prisma.employee.findFirst({
        where: { id: employeeId, tenantId, deletedAt: null },
      });

      if (!employee) {
        throw Object.assign(new Error('Employee not found'), { status: 404 });
      }

      // 점수 배열에서 평균 계산 (scores 객체의 값들)
      const scoreValues = Object.values(scores).filter(
        (v): v is number => typeof v === 'number'
      );
      const overallScore =
        scoreValues.length > 0
          ? Math.round((scoreValues.reduce((sum, v) => sum + v, 0) / scoreValues.length) * 100) / 100
          : null;

      const review = await prisma.performanceReview.create({
        data: {
          employeeId,
          reviewerId,
          reviewPeriod: period,
          managerReview: scores as unknown as Record<string, unknown>,
          comments: feedback,
          overallScore,
          status: 'DRAFT',
          tenantId,
        },
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              employeeNumber: true,
              department: true,
              position: true,
            },
          },
        },
      });

      return res.status(201).json({ data: review });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/performance/reviews/:reviewId — 성과 평가 수정
router.put(
  '/reviews/:reviewId',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(updateReviewSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { reviewId } = req.params;
      const { scores, feedback, status } = req.body;

      const existingReview = await prisma.performanceReview.findFirst({
        where: { id: reviewId, tenantId },
      });

      if (!existingReview) {
        throw Object.assign(new Error('Performance review not found'), { status: 404 });
      }

      const updateData: Record<string, unknown> = {};

      if (scores !== undefined) {
        updateData.managerReview = scores;

        // 점수 업데이트 시 overallScore 재계산
        const scoreValues = Object.values(scores).filter(
          (v): v is number => typeof v === 'number'
        );
        if (scoreValues.length > 0) {
          updateData.overallScore =
            Math.round((scoreValues.reduce((sum, v) => sum + v, 0) / scoreValues.length) * 100) / 100;
        }
      }

      if (feedback !== undefined) {
        updateData.comments = feedback;
      }

      if (status !== undefined) {
        updateData.status = status;

        if (status === 'COMPLETED') {
          updateData.completedAt = new Date();
        }
      }

      const review = await prisma.performanceReview.update({
        where: { id: reviewId },
        data: updateData,
        include: {
          employee: {
            select: {
              id: true,
              name: true,
              employeeNumber: true,
              department: true,
              position: true,
            },
          },
        },
      });

      return res.json({ data: review });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
