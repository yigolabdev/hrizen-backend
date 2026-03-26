import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── GET /api/analytics/turnover-risk ─────────────────────────────────────────
router.get(
  '/turnover-risk',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);
      const department = req.query.department as string | undefined;

      const whereClause: Record<string, unknown> = {
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
      };

      if (department) {
        whereClause.department = department;
      }

      const [employees, total] = await Promise.all([
        prisma.employee.findMany({
          where: whereClause,
          skip,
          take: limit,
          orderBy: { [sortBy === 'riskScore' ? 'hireDate' : sortBy]: sortOrder },
          include: {
            performanceReviews: {
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
            attendanceRecords: {
              where: {
                date: {
                  gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
                },
              },
            },
            leaveRequests: {
              where: {
                status: 'APPROVED',
                startDate: {
                  gte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000),
                },
              },
            },
          },
        }),
        prisma.employee.count({ where: whereClause }),
      ]);

      const data = employees.map((emp) => {
        const now = new Date();
        const hireDate = new Date(emp.hireDate);
        const tenureYears = parseFloat(
          ((now.getTime() - hireDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000)).toFixed(1)
        );

        const latestReview = emp.performanceReviews[0];
        const satisfactionScore = latestReview?.overallScore
          ? Math.min(100, Math.round((latestReview.overallScore / 5) * 100))
          : 50;

        const factors: string[] = [];
        let riskScore = 0;

        // Factor: Low satisfaction
        if (satisfactionScore < 40) {
          riskScore += 30;
          factors.push('낮은 만족도 점수');
        } else if (satisfactionScore < 60) {
          riskScore += 15;
          factors.push('보통 수준의 만족도');
        }

        // Factor: Short tenure (< 1 year)
        if (tenureYears < 1) {
          riskScore += 15;
          factors.push('짧은 근속 기간');
        }

        // Factor: Frequent absences
        const absentCount = emp.attendanceRecords.filter(
          (a) => a.status === 'ABSENT'
        ).length;
        if (absentCount >= 5) {
          riskScore += 25;
          factors.push('잦은 결근');
        } else if (absentCount >= 3) {
          riskScore += 10;
          factors.push('결근 이력');
        }

        // Factor: Excessive leave
        const leaveCount = emp.leaveRequests.length;
        if (leaveCount >= 5) {
          riskScore += 20;
          factors.push('과도한 휴가 사용');
        }

        riskScore = Math.min(100, riskScore);

        return {
          employeeId: emp.id,
          name: emp.name,
          department: emp.department,
          position: emp.position,
          tenureYears,
          satisfactionScore,
          riskScore,
          riskLevel: riskScore >= 70 ? 'HIGH' : riskScore >= 40 ? 'MEDIUM' : 'LOW',
          factors,
        };
      });

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/analytics/department-stats ──────────────────────────────────────
router.get(
  '/department-stats',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;

      const departments = await prisma.department.findMany({
        where: { tenantId, deletedAt: null },
      });

      const stats = await Promise.all(
        departments.map(async (dept) => {
          const employeeCount = await prisma.employee.count({
            where: { tenantId, department: dept.name, deletedAt: null, status: 'ACTIVE' },
          });

          return {
            departmentId: dept.id,
            name: dept.name,
            employeeCount,
          };
        })
      );

      return res.json({ data: stats });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/analytics/anomalies ────────────────────────────────────────────
router.get(
  '/anomalies',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, skip } = parsePagination(req.query);

      const [anomalies, total] = await Promise.all([
        prisma.attendanceAnomaly.findMany({
          where: { tenantId },
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.attendanceAnomaly.count({ where: { tenantId } }),
      ]);

      const data = anomalies.map((anomaly: any) => ({
        id: anomaly.id,
        type: anomaly.type,
        severity: anomaly.severity,
        status: anomaly.status,
        description: anomaly.description,
        createdAt: anomaly.createdAt,
      }));

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/analytics/summary ──────────────────────────────────────────────
router.get(
  '/summary',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      // Employee count
      const totalEmployees = await prisma.employee.count({
        where: { tenantId, deletedAt: null, status: 'ACTIVE' },
      });

      // Payroll records this month
      const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const payrollRecords = await prisma.payrollRecord.findMany({
        where: { tenantId, month: currentMonthStr },
        select: { netPay: true },
      });

      // Anomaly count
      const anomalyCount = await prisma.attendanceAnomaly.count({
        where: { tenantId, status: 'PENDING' },
      });

      // Attendance count this month
      const attendanceCount = await prisma.attendanceRecord.count({
        where: { tenantId, date: { gte: monthStart, lte: monthEnd } },
      });

      const totalPayroll = payrollRecords.reduce((sum: number, log: any) => sum + (log.netPay ?? 0), 0);

      // Average payroll per employee
      const avgPayroll = totalEmployees > 0 ? Math.round(totalPayroll / totalEmployees) : 0;

      const topDepartments = await prisma.employee.groupBy({
        by: ['department'],
        where: { tenantId, deletedAt: null, status: 'ACTIVE' },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      });

      const departmentBreakdown = topDepartments.map((l: any) => ({
        department: l.department,
        count: l._count.id,
      }));

      return res.json({
        data: {
          totalEmployees,
          totalPayroll,
          avgPayroll,
          anomalyCount,
          attendanceCount,
          departmentBreakdown,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
