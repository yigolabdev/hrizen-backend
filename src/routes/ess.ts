import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import path from 'path';
import fs from 'fs';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const createLeaveRequestSchema = z.object({
  body: z.object({
    leaveType: z.string().min(1, 'leaveType is required'),
    startDate: z.string().datetime({ message: 'startDate must be a valid ISO datetime string' }),
    endDate: z.string().datetime({ message: 'endDate must be a valid ISO datetime string' }),
    reason: z.string().min(1, 'reason is required').max(1000),
  }).refine((data) => new Date(data.endDate) >= new Date(data.startDate), {
    message: 'endDate must be after or equal to startDate',
    path: ['endDate'],
  }),
});

const signContractSchema = z.object({
  body: z.object({
    signatureData: z.string().optional(),
  }),
});

// ─── Helper: Get employee for authenticated user ─────────

async function getEmployeeForUser(req: AuthRequest) {
  const userId = req.user!.id;
  const tenantId = req.user!.tenantId;

  const employee = await prisma.employee.findFirst({
    where: {
      userId,
      tenantId,
      deletedAt: null,
    },
  });

  if (!employee) {
    throw Object.assign(new Error('Employee profile not found for this user'), { status: 404 });
  }

  return employee;
}

// ─── Helper: Calculate business days between two dates ───

function calculateLeaveDays(startDate: Date, endDate: Date): number {
  let count = 0;
  const current = new Date(startDate);
  while (current <= endDate) {
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  return count;
}

// ─── GET /api/ess/my-attendance ──────────────────────────
// 직원 본인 근태 요약 조회

router.get('/my-attendance', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const employee = await getEmployeeForUser(req);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Get this month's attendance records
    const monthlyRecords = await prisma.attendanceRecord.findMany({
      where: {
        employeeId: employee.id,
        tenantId: employee.tenantId,
        date: {
          gte: monthStart,
          lte: monthEnd,
        },
      },
      orderBy: { date: 'asc' },
    });

    const monthlyAttendanceDays = monthlyRecords.length;
    const lateDays = monthlyRecords.filter((r) => r.status === 'LATE').length;

    // Calculate remaining leave
    const currentYear = now.getFullYear();
    const yearStart = new Date(currentYear, 0, 1);
    const yearEnd = new Date(currentYear, 11, 31, 23, 59, 59, 999);

    const approvedLeaves = await prisma.leaveRequest.findMany({
      where: {
        employeeId: employee.id,
        tenantId: employee.tenantId,
        status: 'APPROVED',
        startDate: {
          gte: yearStart,
          lte: yearEnd,
        },
      },
    });

    const totalUsedLeaveDays = approvedLeaves.reduce((sum, leave) => sum + leave.days, 0);
    const annualLeaveAllowance = 15; // Default annual leave days
    const remainingLeave = Math.max(0, annualLeaveAllowance - totalUsedLeaveDays);

    // Weekly work hours calculation
    const dayOfWeek = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const weeklyRecords = await prisma.attendanceRecord.findMany({
      where: {
        employeeId: employee.id,
        tenantId: employee.tenantId,
        date: {
          gte: weekStart,
          lte: weekEnd,
        },
      },
      orderBy: { date: 'asc' },
    });

    let weeklyWorkHours = 0;
    const weeklyData: { day: string; hours: number }[] = [];
    const dayNames = ['월', '화', '수', '목', '금', '토', '일'];

    for (let i = 0; i < 7; i++) {
      const targetDate = new Date(weekStart);
      targetDate.setDate(weekStart.getDate() + i);
      const dateStr = targetDate.toISOString().split('T')[0];

      const dayRecord = weeklyRecords.find(
        (r) => r.date.toISOString().split('T')[0] === dateStr
      );

      let hours = 0;
      if (dayRecord && dayRecord.clockIn && dayRecord.clockOut) {
        hours = Math.round(
          ((dayRecord.clockOut.getTime() - dayRecord.clockIn.getTime()) / (1000 * 60 * 60)) * 10
        ) / 10;
      } else if (dayRecord && dayRecord.clockIn) {
        // If still clocked in today, calculate up to now
        const endTime = targetDate.toISOString().split('T')[0] === now.toISOString().split('T')[0] ? now : dayRecord.clockIn;
        if (endTime > dayRecord.clockIn) {
          hours = Math.round(
            ((endTime.getTime() - dayRecord.clockIn.getTime()) / (1000 * 60 * 60)) * 10
          ) / 10;
        }
      }

      hours += (dayRecord?.overtimeMinutes ?? 0) / 60;

      weeklyWorkHours += hours;
      weeklyData.push({ day: dayNames[i], hours: Math.round(hours * 10) / 10 });
    }

    weeklyWorkHours = Math.round(weeklyWorkHours * 10) / 10;

    // Today's records
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const todayRecordList = await prisma.attendanceRecord.findMany({
      where: {
        employeeId: employee.id,
        tenantId: employee.tenantId,
        date: {
          gte: todayStart,
          lte: todayEnd,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const todayRecords: { label: string; time: string; status: string }[] = [];

    for (const record of todayRecordList) {
      if (record.clockIn) {
        todayRecords.push({
          label: '출근',
          time: record.clockIn.toISOString(),
          status: record.status === 'LATE' ? 'LATE' : 'NORMAL',
        });
      }
      if (record.clockOut) {
        todayRecords.push({
          label: '퇴근',
          time: record.clockOut.toISOString(),
          status: record.status === 'EARLY_LEAVE' ? 'EARLY_LEAVE' : 'NORMAL',
        });
      }
    }

    if (todayRecords.length === 0) {
      todayRecords.push({
        label: '출근',
        time: '-',
        status: 'NOT_YET',
      });
    }

    return res.json({
      data: {
        monthlyAttendanceDays,
        lateDays,
        remainingLeave,
        weeklyWorkHours,
        todayRecords,
        weeklyData,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/ess/my-leave-requests ──────────────────────
// 직원 본인 휴가 신청 내역 조회

router.get('/my-leave-requests', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const employee = await getEmployeeForUser(req);
    const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);

    const where = {
      employeeId: employee.id,
      tenantId: employee.tenantId,
    };

    const [data, total] = await Promise.all([
      prisma.leaveRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy === 'createdAt' ? 'requestedAt' : sortBy]: sortOrder },
      }),
      prisma.leaveRequest.count({ where }),
    ]);

    return res.json(paginatedResponse(data, total, page, limit));
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/ess/leave-requests ────────────────────────
// 직원 본인 휴가 신청 등록

router.post('/leave-requests', authenticate, validate(createLeaveRequestSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const employee = await getEmployeeForUser(req);

    const { leaveType, startDate, endDate, reason } = req.body as {
      leaveType: string;
      startDate: string;
      endDate: string;
      reason: string;
    };

    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = calculateLeaveDays(start, end);

    if (days <= 0) {
      throw Object.assign(new Error('Leave duration must be at least 1 business day'), { status: 400 });
    }

    // Check remaining leave
    const currentYear = new Date().getFullYear();
    const yearStart = new Date(currentYear, 0, 1);
    const yearEnd = new Date(currentYear, 11, 31, 23, 59, 59, 999);

    const approvedOrPendingLeaves = await prisma.leaveRequest.findMany({
      where: {
        employeeId: employee.id,
        tenantId: employee.tenantId,
        status: { in: ['APPROVED', 'PENDING'] },
        startDate: {
          gte: yearStart,
          lte: yearEnd,
        },
      },
    });

    const totalUsedDays = approvedOrPendingLeaves.reduce((sum, l) => sum + l.days, 0);
    const annualLeaveAllowance = 15;

    if (totalUsedDays + days > annualLeaveAllowance) {
      throw Object.assign(
        new Error(`Insufficient leave balance. Remaining: ${annualLeaveAllowance - totalUsedDays} days, Requested: ${days} days`),
        { status: 400 }
      );
    }

    // Check for overlapping leave requests
    const overlapping = await prisma.leaveRequest.findFirst({
      where: {
        employeeId: employee.id,
        tenantId: employee.tenantId,
        status: { in: ['APPROVED', 'PENDING'] },
        OR: [
          {
            startDate: { lte: end },
            endDate: { gte: start },
          },
        ],
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
        employeeId: employee.id,
        tenantId: employee.tenantId,
      },
    });

    return res.status(201).json({ data: leaveRequest });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/ess/contracts ──────────────────────────────
// 직원 본인 계약 문서 목록 조회

router.get('/contracts', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const employee = await getEmployeeForUser(req);
    const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);

    const where = {
      employeeId: employee.id,
      tenantId: employee.tenantId,
    };

    const [data, total] = await Promise.all([
      prisma.contract.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.contract.count({ where }),
    ]);

    return res.json(paginatedResponse(data, total, page, limit));
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/ess/contracts/:contractId ──────────────────
// 계약 문서 상세 조회

router.get('/contracts/:contractId', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const employee = await getEmployeeForUser(req);
    const { contractId } = req.params;

    const contract = await prisma.contract.findFirst({
      where: {
        id: contractId,
        employeeId: employee.id,
        tenantId: employee.tenantId,
      },
    });

    if (!contract) {
      throw Object.assign(new Error('Contract not found'), { status: 404 });
    }

    return res.json({ data: contract });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/ess/contracts/:contractId/sign ────────────
// 계약 문서 전자서명 처리

router.post('/contracts/:contractId/sign', authenticate, validate(signContractSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const employee = await getEmployeeForUser(req);
    const { contractId } = req.params;
    const { signatureData } = req.body as { signatureData?: string };

    const contract = await prisma.contract.findFirst({
      where: {
        id: contractId,
        employeeId: employee.id,
        tenantId: employee.tenantId,
      },
    });

    if (!contract) {
      throw Object.assign(new Error('Contract not found'), { status: 404 });
    }

    if (contract.status === 'SIGNED') {
      throw Object.assign(new Error('Contract is already signed'), { status: 409 });
    }

    if (contract.status === 'EXPIRED') {
      throw Object.assign(new Error('Contract has expired and cannot be signed'), { status: 400 });
    }

    if (contract.status === 'CANCELLED') {
      throw Object.assign(new Error('Contract has been cancelled'), { status: 400 });
    }

    const signedAt = new Date();

    await prisma.contract.update({
      where: { id: contractId },
      data: {
        status: 'SIGNED',
        signedAt,
        signatureData: signatureData ?? null,
      },
    });

    // Log the signing activity
    await prisma.activityLog.create({
      data: {
        action: 'SIGN',
        resource: 'Contract',
        resourceId: contractId,
        description: `Employee ${employee.name} signed contract: ${contract.title}`,
        userId: req.user!.id,
        tenantId: employee.tenantId,
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      },
    });

    return res.json({
      data: {
        success: true,
        signedAt: signedAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/ess/contracts/:contractId/download ─────────
// 계약 문서 PDF 다운로드

router.get('/contracts/:contractId/download', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const employee = await getEmployeeForUser(req);
    const { contractId } = req.params;

    const contract = await prisma.contract.findFirst({
      where: {
        id: contractId,
        employeeId: employee.id,
        tenantId: employee.tenantId,
      },
    });

    if (!contract) {
      throw Object.assign(new Error('Contract not found'), { status: 404 });
    }

    if (!contract.fileUrl) {
      throw Object.assign(new Error('Contract file not available'), { status: 404 });
    }

    const filePath = path.resolve(contract.fileUrl);

    // Verify file exists
    if (!fs.existsSync(filePath)) {
      throw Object.assign(new Error('Contract file not found on server'), { status: 404 });
    }

    // Log the download activity
    await prisma.activityLog.create({
      data: {
        action: 'DOWNLOAD',
        resource: 'Contract',
        resourceId: contractId,
        description: `Employee ${employee.name} downloaded contract: ${contract.title}`,
        userId: req.user!.id,
        tenantId: employee.tenantId,
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      },
    });

    const fileName = `${contract.title.replace(/[^a-zA-Z0-9가-힣\s-_]/g, '')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (err) {
    next(err);
  }
});

export default router;
