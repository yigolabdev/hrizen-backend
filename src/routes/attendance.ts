import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const clockInSchema = z.object({
  employeeId: z.string().min(1, 'employeeId is required'),
  timestamp: z.string().datetime().optional(),
});

const clockOutSchema = z.object({
  employeeId: z.string().min(1, 'employeeId is required'),
  timestamp: z.string().datetime().optional(),
});

const createLeaveRequestSchema = z.object({
  employeeId: z.string().min(1, 'employeeId is required'),
  leaveType: z.string().min(1, 'leaveType is required'),
  startDate: z.string().datetime({ message: 'startDate must be a valid ISO datetime' }),
  endDate: z.string().datetime({ message: 'endDate must be a valid ISO datetime' }),
  days: z.number().positive('days must be a positive number'),
  reason: z.string().min(1, 'reason is required'),
});

const updateLeaveRequestSchema = z.object({
  status: z.enum(['approved', 'rejected'], { required_error: 'status must be approved or rejected' }),
  reason: z.string().optional(),
});

const dismissAnomalySchema = z.object({}).optional();

// ─── GET /api/attendance/records ─────────────────────────
// 근태 기록 목록 조회 (날짜/직원/상태 필터, 페이지네이션)
router.get(
  '/records',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);
      const tenantId = req.user!.tenantId;

      const where: Record<string, unknown> = { tenantId };

      // 날짜 필터
      if (req.query.date) {
        const dateStr = req.query.date as string;
        const startOfDay = new Date(dateStr);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(dateStr);
        endOfDay.setHours(23, 59, 59, 999);
        where.date = { gte: startOfDay, lte: endOfDay };
      }

      if (req.query.startDate || req.query.endDate) {
        const dateFilter: Record<string, Date> = {};
        if (req.query.startDate) {
          dateFilter.gte = new Date(req.query.startDate as string);
        }
        if (req.query.endDate) {
          dateFilter.lte = new Date(req.query.endDate as string);
        }
        if (!where.date) {
          where.date = dateFilter;
        }
      }

      // 직원 필터
      if (req.query.employeeId) {
        where.employeeId = req.query.employeeId as string;
      }

      // 상태 필터
      if (req.query.status) {
        where.status = req.query.status as string;
      }

      const validSortFields = ['date', 'createdAt', 'status', 'clockIn', 'clockOut'];
      const orderByField = validSortFields.includes(sortBy) ? sortBy : 'date';

      const [data, total] = await Promise.all([
        prisma.attendanceRecord.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [orderByField]: sortOrder },
          include: {
            employee: {
              select: { name: true, department: true, position: true },
            },
          },
        }),
        prisma.attendanceRecord.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/attendance/clock-in ───────────────────────
router.post(
  '/clock-in',
  authenticate,
  validate(clockInSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId, timestamp } = req.body as { employeeId: string; timestamp?: string };

      const employee = await prisma.employee.findFirst({
        where: { id: employeeId, tenantId, deletedAt: null },
      });

      if (!employee) {
        throw Object.assign(new Error('Employee not found'), { status: 404 });
      }

      const clockInTime = timestamp ? new Date(timestamp) : new Date();
      const today = new Date(clockInTime);
      today.setHours(0, 0, 0, 0);

      // Check if already clocked in today
      const existingRecord = await prisma.attendanceRecord.findFirst({
        where: {
          employeeId,
          tenantId,
          date: today,
        },
      });

      if (existingRecord) {
        throw Object.assign(new Error('Already clocked in today'), { status: 409 });
      }

      // Determine status based on clock-in time
      const hour = clockInTime.getHours();
      const status = hour >= 9 ? 'LATE' : 'NORMAL';

      const record = await prisma.attendanceRecord.create({
        data: {
          tenantId,
          employeeId,
          date: today,
          clockIn: clockInTime,
          status,
        },
      });

      return res.status(201).json({ data: record });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/attendance/clock-out ──────────────────────
router.post(
  '/clock-out',
  authenticate,
  validate(clockOutSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId, timestamp } = req.body as { employeeId: string; timestamp?: string };

      const clockOutTime = timestamp ? new Date(timestamp) : new Date();
      const today = new Date(clockOutTime);
      today.setHours(0, 0, 0, 0);

      const existingRecord = await prisma.attendanceRecord.findFirst({
        where: {
          employeeId,
          tenantId,
          date: today,
          clockOut: null,
        },
      });

      if (!existingRecord) {
        throw Object.assign(new Error('No clock-in record found for today'), { status: 404 });
      }

      const record = await prisma.attendanceRecord.update({
        where: { id: existingRecord.id },
        data: {
          clockOut: clockOutTime,
        },
      });

      return res.json({ data: record });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/attendance/leave-requests ───────────────────
router.get(
  '/leave-requests',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);

      const where: Record<string, unknown> = { tenantId };

      if (req.query.status) {
        where.status = req.query.status as string;
      }
      if (req.query.employeeId) {
        where.employeeId = req.query.employeeId as string;
      }

      const [data, total] = await Promise.all([
        prisma.leaveRequest.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [sortBy]: sortOrder },
          include: {
            employee: {
              select: { name: true, department: true },
            },
          },
        }),
        prisma.leaveRequest.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/attendance/leave-requests ─────────────────
router.post(
  '/leave-requests',
  authenticate,
  validate(createLeaveRequestSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId, leaveType, startDate, endDate, days, reason } = req.body;

      const employee = await prisma.employee.findFirst({
        where: { id: employeeId, tenantId, deletedAt: null },
      });

      if (!employee) {
        throw Object.assign(new Error('Employee not found'), { status: 404 });
      }

      const leaveRequest = await prisma.leaveRequest.create({
        data: {
          tenantId,
          employeeId,
          leaveType,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          days,
          reason,
          status: 'PENDING',
        },
      });

      return res.status(201).json({ data: leaveRequest });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /api/attendance/leave-requests/:id ────────────
router.patch(
  '/leave-requests/:id',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(updateLeaveRequestSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const leaveRequestId = req.params.id as string;
      const { status, reason } = req.body as { status: string; reason?: string };

      const existing = await prisma.leaveRequest.findFirst({
        where: { id: leaveRequestId, tenantId },
      });

      if (!existing) {
        throw Object.assign(new Error('Leave request not found'), { status: 404 });
      }

      const reviewerId = req.user!.id;
      const leaveRequest = await prisma.leaveRequest.update({
        where: { id: leaveRequestId },
        data: {
          status: status.toUpperCase(),
          reviewedBy: reviewerId,
        },
      });

      return res.json({ data: leaveRequest });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/attendance/overtime-summary ─────────────────
router.get(
  '/overtime-summary',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      const records = await prisma.attendanceRecord.findMany({
        where: {
          tenantId,
          date: { gte: monthStart, lte: monthEnd },
          clockIn: { not: null },
          clockOut: { not: null },
        },
        select: {
          id: true,
          employeeId: true,
          clockIn: true,
          clockOut: true,
          date: true,
          status: true,
        },
      });

      // Calculate overtime from clock-in/clock-out (over 8 hours)
      const overtimeData = records.map((record) => {
        const clockIn = record.clockIn;
        const clockOut = record.clockOut;
        let overtimeMinutes = 0;
        if (clockIn && clockOut) {
          const workedMinutes = (clockOut.getTime() - clockIn.getTime()) / (1000 * 60);
          overtimeMinutes = Math.max(0, workedMinutes - 480); // 480 min = 8 hours
        }
        return {
          ...record,
          overtimeMinutes,
        };
      });

      const totalOvertimeMinutes = overtimeData.reduce((sum, r) => sum + r.overtimeMinutes, 0);

      return res.json({
        data: {
          totalOvertimeMinutes,
          totalOvertimeHours: Math.round(totalOvertimeMinutes / 60 * 100) / 100,
          recordCount: overtimeData.length,
          records: overtimeData,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
