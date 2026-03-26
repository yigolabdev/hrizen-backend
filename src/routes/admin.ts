import { Router, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── GET /api/admin/dashboard/summary ────────────────────────────────────────
router.get(
  '/dashboard/summary',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;

      // Total active employees
      const totalEmployees = await prisma.employee.count({
        where: { tenantId, deletedAt: null, status: 'ACTIVE' },
      });

      // Current month date range
      const now = new Date();
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      // Previous month date range
      const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

      // Current month attendance
      const currentAttendanceTotal = await prisma.attendanceRecord.count({
        where: { tenantId, date: { gte: currentMonthStart, lte: currentMonthEnd } },
      });
      const currentAttendanceNormal = await prisma.attendanceRecord.count({
        where: { tenantId, date: { gte: currentMonthStart, lte: currentMonthEnd }, status: 'NORMAL' },
      });

      // Previous month attendance
      const prevAttendanceTotal = await prisma.attendanceRecord.count({
        where: { tenantId, date: { gte: prevMonthStart, lte: prevMonthEnd } },
      });
      const prevAttendanceNormal = await prisma.attendanceRecord.count({
        where: { tenantId, date: { gte: prevMonthStart, lte: prevMonthEnd }, status: 'NORMAL' },
      });

      const attendanceRate = currentAttendanceTotal > 0
        ? Math.round((currentAttendanceNormal / currentAttendanceTotal) * 10000) / 100
        : 0;
      const prevAttendanceRate = prevAttendanceTotal > 0
        ? Math.round((prevAttendanceNormal / prevAttendanceTotal) * 10000) / 100
        : 0;

      const attendanceDiff = Math.round((attendanceRate - prevAttendanceRate) * 100) / 100;
      const attendanceTrend = {
        direction: attendanceDiff > 0 ? 'up' : attendanceDiff < 0 ? 'down' : 'flat',
        value: `${Math.abs(attendanceDiff)}%`,
      };

      // Current month payroll
      const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevMonthStr = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

      const currentPayrollAgg = await prisma.payrollRecord.aggregate({
        where: { tenantId, month: currentMonthStr },
        _sum: { netPay: true },
      });
      const prevPayrollAgg = await prisma.payrollRecord.aggregate({
        where: { tenantId, month: prevMonthStr },
        _sum: { netPay: true },
      });

      const currentPayroll = currentPayrollAgg._sum.netPay ?? 0;
      const prevPayroll = prevPayrollAgg._sum.netPay ?? 0;
      const payrollDiff = prevPayroll > 0
        ? Math.round(((currentPayroll - prevPayroll) / prevPayroll) * 10000) / 100
        : 0;

      // Anomaly count
      const anomalyCount = await prisma.attendanceAnomaly.count({
        where: { tenantId, status: 'PENDING' },
      });

      // Previous month anomaly count
      const prevAnomalyCount = await prisma.attendanceAnomaly.count({
        where: {
          tenantId,
          status: 'PENDING',
          createdAt: { gte: prevMonthStart, lte: prevMonthEnd },
        },
      });

      return res.json({
        data: {
          totalEmployees,
          attendanceRate,
          attendanceTrend,
          currentPayroll,
          payrollDiff,
          anomalyCount,
          prevAnomalyCount,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/admin/dashboard/recent-activities ──────────────────────────────
router.get(
  '/dashboard/recent-activities',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, skip } = parsePagination(req.query);

      // Try to get recent attendance records as activity
      const recentAttendance = await prisma.attendanceRecord.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
        include: {
          employee: {
            select: { name: true, department: true },
          },
        },
      });

      const total = await prisma.attendanceRecord.count({
        where: { tenantId },
      });

      const activities = recentAttendance.map((activity: any) => ({
        id: activity.id,
        type: 'attendance',
        description: `${activity.employee?.name ?? 'Unknown'} - ${activity.status}`,
        date: activity.date,
        createdAt: activity.createdAt,
      }));

      return res.json(paginatedResponse(activities, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/admin/dashboard/anomalies ──────────────────────────────────────
router.get(
  '/dashboard/anomalies',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, skip, sortOrder } = parsePagination(req.query);

      const [data, total] = await Promise.all([
        prisma.attendanceAnomaly.findMany({
          where: { tenantId },
          skip,
          take: limit,
          orderBy: { createdAt: sortOrder },
          include: {
            employee: {
              select: { name: true, department: true },
            },
          },
        }),
        prisma.attendanceAnomaly.count({ where: { tenantId } }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/admin/dashboard/payroll-summary ────────────────────────────────
router.get(
  '/dashboard/payroll-summary',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;

      const now = new Date();
      const months: string[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }

      const payrollRecords = await prisma.payrollRecord.findMany({
        where: { tenantId, month: { in: months } },
        select: { month: true, netPay: true },
      });

      const monthlySummary = months.map((month) => {
        const records = payrollRecords.filter((r) => r.month === month);
        const totalNetPay = records.reduce((sum: number, a: any) => sum + (a.netPay ?? 0), 0);
        return { month, totalNetPay, recordCount: records.length };
      });

      return res.json({ data: monthlySummary });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
