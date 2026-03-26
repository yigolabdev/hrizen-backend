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
        prisma.attendanceRecord.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/attendance/clock-in ──────────────────────
// 출근 기록 등록
router.post(
  '/clock-in',
  authenticate,
  validate(clockInSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId, timestamp } = req.body;

      // 직원 존재 확인
      const employee = await prisma.employee.findFirst({
        where: { id: employeeId, tenantId, deletedAt: null },
      });

      if (!employee) {
        throw Object.assign(new Error('Employee not found'), { status: 404 });
      }

      const clockInTime = timestamp ? new Date(timestamp) : new Date();
      const recordDate = new Date(clockInTime);
      recordDate.setHours(0, 0, 0, 0);

      // 같은 날 이미 출근 기록이 있는지 확인
      const startOfDay = new Date(recordDate);
      const endOfDay = new Date(recordDate);
      endOfDay.setHours(23, 59, 59, 999);

      const existingRecord = await prisma.attendanceRecord.findFirst({
        where: {
          employeeId,
          tenantId,
          date: { gte: startOfDay, lte: endOfDay },
          clockIn: { not: null },
        },
      });

      if (existingRecord) {
        throw Object.assign(new Error('Clock-in record already exists for this date'), { status: 409 });
      }

      // 지각 판단 (09:00 기준)
      const lateThreshold = new Date(clockInTime);
      lateThreshold.setHours(9, 0, 0, 0);
      const status = clockInTime > lateThreshold ? 'LATE' : 'NORMAL';

      const record = await prisma.attendanceRecord.create({
        data: {
          date: startOfDay,
          clockIn: clockInTime,
          status: status as 'NORMAL' | 'LATE',
          employeeId,
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

      return res.status(201).json({ data: record });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/attendance/clock-out ─────────────────────
// 퇴근 기록 등록
router.post(
  '/clock-out',
  authenticate,
  validate(clockOutSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId, timestamp } = req.body;

      // 직원 존재 확인
      const employee = await prisma.employee.findFirst({
        where: { id: employeeId, tenantId, deletedAt: null },
      });

      if (!employee) {
        throw Object.assign(new Error('Employee not found'), { status: 404 });
      }

      const clockOutTime = timestamp ? new Date(timestamp) : new Date();
      const startOfDay = new Date(clockOutTime);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(clockOutTime);
      endOfDay.setHours(23, 59, 59, 999);

      // 당일 출근 기록 찾기
      const existingRecord = await prisma.attendanceRecord.findFirst({
        where: {
          employeeId,
          tenantId,
          date: { gte: startOfDay, lte: endOfDay },
          clockIn: { not: null },
        },
      });

      if (!existingRecord) {
        throw Object.assign(new Error('No clock-in record found for today'), { status: 404 });
      }

      if (existingRecord.clockOut) {
        throw Object.assign(new Error('Clock-out record already exists for this date'), { status: 409 });
      }

      // 초과근무 계산 (18:00 이후)
      const standardEnd = new Date(clockOutTime);
      standardEnd.setHours(18, 0, 0, 0);
      let overtimeMinutes = 0;
      if (clockOutTime > standardEnd) {
        overtimeMinutes = Math.floor((clockOutTime.getTime() - standardEnd.getTime()) / (1000 * 60));
      }

      // 조기퇴근 판단 (18:00 이전)
      const earlyLeaveThreshold = new Date(clockOutTime);
      earlyLeaveThreshold.setHours(18, 0, 0, 0);
      let status = existingRecord.status;
      if (clockOutTime < earlyLeaveThreshold) {
        status = 'EARLY_LEAVE';
      }

      const record = await prisma.attendanceRecord.update({
        where: { id: existingRecord.id },
        data: {
          clockOut: clockOutTime,
          overtimeMinutes,
          status: status as 'NORMAL' | 'LATE' | 'EARLY_LEAVE',
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

      return res.status(201).json({ data: record });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/attendance/leave-requests ──────────────────
// 휴가/연차 신청 목록 조회
router.get(
  '/leave-requests',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);
      const tenantId = req.user!.tenantId;

      const where: Record<string, unknown> = { tenantId };

      if (req.query.status) {
        where.status = (req.query.status as string).toUpperCase();
      }

      if (req.query.employeeId) {
        where.employeeId = req.query.employeeId as string;
      }

      if (req.query.leaveType) {
        where.leaveType = req.query.leaveType as string;
      }

      const validSortFields = ['requestedAt', 'startDate', 'endDate', 'status', 'days'];
      const orderByField = validSortFields.includes(sortBy) ? sortBy : 'requestedAt';

      const [data, total] = await Promise.all([
        prisma.leaveRequest.findMany({
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
        prisma.leaveRequest.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/attendance/leave-requests ─────────────────
// 휴가/연차 신청 생성
router.post(
  '/leave-requests',
  authenticate,
  validate(createLeaveRequestSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId, leaveType, startDate, endDate, days, reason } = req.body;

      // 직원 존재 확인
      const employee = await prisma.employee.findFirst({
        where: { id: employeeId, tenantId, deletedAt: null },
      });

      if (!employee) {
        throw Object.assign(new Error('Employee not found'), { status: 404 });
      }

      // 날짜 유효성 확인
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (end < start) {
        throw Object.assign(new Error('endDate must be after startDate'), { status: 400 });
      }

      // 중복 휴가 신청 확인 (동일 기간 PENDING/APPROVED 상태)
      const overlapping = await prisma.leaveRequest.findFirst({
        where: {
          employeeId,
          tenantId,
          status: { in: ['PENDING', 'APPROVED'] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
      });

      if (overlapping) {
        throw Object.assign(new Error('Overlapping leave request already exists'), { status: 409 });
      }

      const leaveRequest = await prisma.leaveRequest.create({
        data: {
          leaveType,
          startDate: start,
          endDate: end,
          days,
          reason,
          status: 'PENDING',
          employeeId,
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

      return res.status(201).json({ data: leaveRequest });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/attendance/leave-requests/:requestId ──────
// 휴가 신청 상태 변경 (승인/반려)
router.put(
  '/leave-requests/:requestId',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(updateLeaveRequestSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { requestId } = req.params;
      const { status, reason } = req.body;

      const leaveRequest = await prisma.leaveRequest.findFirst({
        where: { id: requestId, tenantId },
      });

      if (!leaveRequest) {
        throw Object.assign(new Error('Leave request not found'), { status: 404 });
      }

      if (leaveRequest.status !== 'PENDING') {
        throw Object.assign(
          new Error(`Cannot update leave request with status: ${leaveRequest.status}`),
          { status: 400 }
        );
      }

      const updatedStatus = status.toUpperCase() as 'APPROVED' | 'REJECTED';

      const updated = await prisma.leaveRequest.update({
        where: { id: requestId },
        data: {
          status: updatedStatus,
          reviewedBy: req.user!.userId,
          reviewedAt: new Date(),
          ...(reason && updatedStatus === 'REJECTED' ? { reason } : {}),
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

      return res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/attendance/overtime-stats ──────────────────
// 초과근무 통계 조회 (전체 및 부서별)
router.get(
  '/overtime-stats',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;

      // 기간 필터 (선택적)
      const dateFilter: Record<string, Date> = {};
      if (req.query.startDate) {
        dateFilter.gte = new Date(req.query.startDate as string);
      }
      if (req.query.endDate) {
        dateFilter.lte = new Date(req.query.endDate as string);
      }

      const whereClause: Record<string, unknown> = {
        tenantId,
        overtimeMinutes: { gt: 0 },
      };
      if (Object.keys(dateFilter).length > 0) {
        whereClause.date = dateFilter;
      }

      // 전체 초과근무 기록 가져오기 (직원 정보 포함)
      const overtimeRecords = await prisma.attendanceRecord.findMany({
        where: whereClause,
        select: {
          employeeId: true,
          overtimeMinutes: true,
          employee: {
            select: {
              id: true,
              department: true,
            },
          },
        },
      });

      // 직원별 초과근무 시간 집계
      const employeeOvertimeMap = new Map<string, { totalMinutes: number; department: string }>();

      for (const record of overtimeRecords) {
        const existing = employeeOvertimeMap.get(record.employeeId);
        if (existing) {
          existing.totalMinutes += record.overtimeMinutes;
        } else {
          employeeOvertimeMap.set(record.employeeId, {
            totalMinutes: record.overtimeMinutes,
            department: record.employee.department,
          });
        }
      }

      const employeeEntries = Array.from(employeeOvertimeMap.values());
      const totalEmployees = employeeEntries.length;

      const totalOvertimeHours = employeeEntries.reduce(
        (sum, e) => sum + e.totalMinutes / 60,
        0
      );
      const avgOvertimeHours = totalEmployees > 0
        ? Math.round((totalOvertimeHours / totalEmployees) * 100) / 100
        : 0;
      const maxOvertimeHours = totalEmployees > 0
        ? Math.round((Math.max(...employeeEntries.map((e) => e.totalMinutes)) / 60) * 100) / 100
        : 0;

      // 월 52시간 (주 52시간 기준, 월 환산 약 208시간에서 법정 근로시간 제외)
      const OVERTIME_LIMIT_MINUTES = 52 * 60; // 주 52시간 제한 (월 기준 간소화)
      const overLimitCount = employeeEntries.filter(
        (e) => e.totalMinutes > OVERTIME_LIMIT_MINUTES
      ).length;

      // 부서별 통계
      const departmentMap = new Map<string, { totalMinutes: number; employeeCount: number }>();

      for (const entry of employeeEntries) {
        const dept = departmentMap.get(entry.department);
        if (dept) {
          dept.totalMinutes += entry.totalMinutes;
          dept.employeeCount += 1;
        } else {
          departmentMap.set(entry.department, {
            totalMinutes: entry.totalMinutes,
            employeeCount: 1,
          });
        }
      }

      const departmentStats = Array.from(departmentMap.entries()).map(
        ([department, stats]) => ({
          department,
          avgHours:
            Math.round((stats.totalMinutes / 60 / stats.employeeCount) * 100) / 100,
          employeeCount: stats.employeeCount,
        })
      );

      return res.json({
        data: {
          totalEmployees,
          avgOvertimeHours,
          maxOvertimeHours,
          overLimitCount,
          departmentStats,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/attendance/anomalies ──────────────────────
// AI 근태 이상 징후 목록 조회
router.get(
  '/anomalies',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);
      const tenantId = req.user!.tenantId;

      const where: Record<string, unknown> = {
        tenantId,
        category: 'ATTENDANCE',
        isDismissed: false,
      };

      if (req.query.severity) {
        where.severity = (req.query.severity as string).toUpperCase();
      }

      if (req.query.isDismissed !== undefined) {
        where.isDismissed = req.query.isDismissed === 'true';
      }

      const validSortFields = ['detectedAt', 'severity', 'createdAt', 'title'];
      const orderByField = validSortFields.includes(sortBy) ? sortBy : 'detectedAt';

      const [data, total] = await Promise.all([
        prisma.anomaly.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [orderByField]: sortOrder },
        }),
        prisma.anomaly.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/attendance/anomalies/:anomalyId/dismiss ───
// 이상 징후 알림 해제(dismiss)
router.put(
  '/anomalies/:anomalyId/dismiss',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { anomalyId } = req.params;

      const anomaly = await prisma.anomaly.findFirst({
        where: { id: anomalyId, tenantId },
      });

      if (!anomaly) {
        throw Object.assign(new Error('Anomaly not found'), { status: 404 });
      }

      if (anomaly.isDismissed) {
        throw Object.assign(new Error('Anomaly is already dismissed'), { status: 400 });
      }

      await prisma.anomaly.update({
        where: { id: anomalyId },
        data: {
          isDismissed: true,
          dismissedBy: req.user!.userId,
          dismissedAt: new Date(),
        },
      });

      return res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
