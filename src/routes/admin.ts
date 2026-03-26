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

      const totalPayroll = currentPayrollAgg._sum.netPay ?? 0;
      const prevTotalPayroll = prevPayrollAgg._sum.netPay ?? 0;

      const payrollDiffPercent = prevTotalPayroll > 0
        ? Math.round(((totalPayroll - prevTotalPayroll) / prevTotalPayroll) * 10000) / 100
        : 0;
      const payrollTrend = {
        direction: payrollDiffPercent > 0 ? 'up' : payrollDiffPercent < 0 ? 'down' : 'flat',
        value: `${Math.abs(payrollDiffPercent)}%`,
      };

      // At-risk count (turnover risk anomalies)
      const atRiskCount = await prisma.anomaly.count({
        where: {
          tenantId,
          category: 'TURNOVER_RISK',
          isDismissed: false,
        },
      });

      // Previous month at-risk for trend
      const prevAtRiskCount = await prisma.anomaly.count({
        where: {
          tenantId,
          category: 'TURNOVER_RISK',
          isDismissed: false,
          detectedAt: { lt: currentMonthStart },
        },
      });

      const riskDiff = atRiskCount - prevAtRiskCount;
      const riskTrend = {
        direction: riskDiff > 0 ? 'up' : riskDiff < 0 ? 'down' : 'flat',
        value: `${Math.abs(riskDiff)}명`,
      };

      return res.json({
        data: {
          totalEmployees,
          attendanceRate,
          attendanceTrend,
          totalPayroll,
          payrollTrend,
          atRiskCount,
          riskTrend,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/admin/dashboard/attendance-chart ───────────────────────────────
router.get(
  '/dashboard/attendance-chart',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const period = (req.query.period as string) || 'weekly';

      const now = new Date();
      let startDate: Date;
      let groupFormat: 'day' | 'month';

      if (period === 'yearly') {
        startDate = new Date(now.getFullYear(), 0, 1);
        groupFormat = 'month';
      } else if (period === 'monthly') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        groupFormat = 'day';
      } else {
        // weekly
        const dayOfWeek = now.getDay();
        const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset);
        startDate.setHours(0, 0, 0, 0);
        groupFormat = 'day';
      }

      const records = await prisma.attendanceRecord.findMany({
        where: {
          tenantId,
          date: { gte: startDate, lte: now },
        },
        select: {
          date: true,
          status: true,
        },
      });

      const grouped = new Map<string, { attendance: number; late: number; absent: number }>();

      for (const record of records) {
        const d = new Date(record.date);
        let label: string;
        if (groupFormat === 'month') {
          label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        } else {
          label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }

        if (!grouped.has(label)) {
          grouped.set(label, { attendance: 0, late: 0, absent: 0 });
        }

        const entry = grouped.get(label)!;
        if (record.status === 'NORMAL' || record.status === 'EARLY_LEAVE' || record.status === 'HALF_DAY') {
          entry.attendance += 1;
        } else if (record.status === 'LATE') {
          entry.late += 1;
        } else if (record.status === 'ABSENT') {
          entry.absent += 1;
        }
      }

      const data = Array.from(grouped.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, values]) => ({
          label,
          attendance: values.attendance,
          late: values.late,
          absent: values.absent,
        }));

      return res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/admin/dashboard/payroll-overview ───────────────────────────────
router.get(
  '/dashboard/payroll-overview',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const now = new Date();
      const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      const payrollRecords = await prisma.payrollRecord.findMany({
        where: { tenantId, month: currentMonthStr },
        select: {
          baseSalary: true,
          overtimePay: true,
          bonus: true,
          mealAllowance: true,
          transportAllowance: true,
          nationalPension: true,
          healthInsurance: true,
          employmentInsurance: true,
          incomeTax: true,
          localIncomeTax: true,
          totalEarnings: true,
          totalDeductions: true,
          netPay: true,
        },
      });

      let baseSalaryTotal = 0;
      let overtimePayTotal = 0;
      let bonusTotal = 0;
      let allowancesTotal = 0;
      let deductionsTotal = 0;
      let totalPayroll = 0;

      for (const record of payrollRecords) {
        baseSalaryTotal += record.baseSalary;
        overtimePayTotal += record.overtimePay;
        bonusTotal += record.bonus;
        allowancesTotal += record.mealAllowance + record.transportAllowance;
        deductionsTotal += record.totalDeductions;
        totalPayroll += record.netPay;
      }

      const items = [
        { name: '기본급', value: Math.round(baseSalaryTotal), color: '#4F46E5' },
        { name: '초과근무수당', value: Math.round(overtimePayTotal), color: '#10B981' },
        { name: '상여금', value: Math.round(bonusTotal), color: '#F59E0B' },
        { name: '수당', value: Math.round(allowancesTotal), color: '#8B5CF6' },
        { name: '공제액', value: Math.round(deductionsTotal), color: '#EF4444' },
      ];

      return res.json({
        data: {
          items,
          totalPayroll: Math.round(totalPayroll),
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

      const where = { tenantId };

      const [activities, total] = await Promise.all([
        prisma.activityLog.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: { name: true },
            },
          },
        }),
        prisma.activityLog.count({ where }),
      ]);

      const statusMap: Record<string, string> = {
        CREATE: 'success',
        UPDATE: 'info',
        DELETE: 'warning',
        APPROVE: 'success',
        REJECT: 'error',
        LOGIN: 'info',
        LOGOUT: 'info',
        DOWNLOAD: 'info',
        SIGN: 'success',
      };

      const data = activities.map((activity) => ({
        id: activity.id,
        type: activity.action,
        title: `${activity.resource} ${activity.action}`,
        description: activity.description ?? `${activity.user.name}님이 ${activity.resource}을(를) ${activity.action.toLowerCase()} 했습니다.`,
        time: activity.createdAt.toISOString(),
        status: statusMap[activity.action] ?? 'info',
      }));

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/admin/dashboard/retention-risk ─────────────────────────────────
router.get(
  '/dashboard/retention-risk',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;

      // Get all departments
      const departments = await prisma.department.findMany({
        where: { tenantId, deletedAt: null },
        select: { name: true, employeeCount: true },
      });

      // Get turnover risk anomalies grouped by department
      const anomalies = await prisma.anomaly.findMany({
        where: {
          tenantId,
          category: 'TURNOVER_RISK',
          isDismissed: false,
        },
        select: {
          department: true,
          severity: true,
          title: true,
          description: true,
          data: true,
        },
      });

      // Group anomalies by department
      const anomalyByDept = new Map<string, typeof anomalies>();
      for (const anomaly of anomalies) {
        const dept = anomaly.department ?? 'Unknown';
        if (!anomalyByDept.has(dept)) {
          anomalyByDept.set(dept, []);
        }
        anomalyByDept.get(dept)!.push(anomaly);
      }

      // Active employee counts per department
      const employeeCounts = await prisma.employee.groupBy({
        by: ['department'],
        where: { tenantId, deletedAt: null, status: 'ACTIVE' },
        _count: { id: true },
      });

      const employeeCountMap = new Map<string, number>();
      for (const ec of employeeCounts) {
        employeeCountMap.set(ec.department, ec._count.id);
      }

      const severityScore: Record<string, number> = {
        LOW: 25,
        MEDIUM: 50,
        HIGH: 75,
        CRITICAL: 100,
      };

      const departmentRisks = departments.map((dept) => {
        const deptAnomalies = anomalyByDept.get(dept.name) ?? [];
        const totalCount = employeeCountMap.get(dept.name) ?? dept.employeeCount;
        const atRiskCount = deptAnomalies.length;

        // Calculate average risk score
        let riskScore = 0;
        if (deptAnomalies.length > 0) {
          const totalScore = deptAnomalies.reduce(
            (sum, a) => sum + (severityScore[a.severity] ?? 50),
            0
          );
          riskScore = Math.round(totalScore / deptAnomalies.length);
        }

        // Determine risk level
        let riskLevel: string;
        if (riskScore >= 75) {
          riskLevel = 'critical';
        } else if (riskScore >= 50) {
          riskLevel = 'high';
        } else if (riskScore >= 25) {
          riskLevel = 'medium';
        } else {
          riskLevel = 'low';
        }

        // Extract top reasons from anomaly descriptions
        const reasonCounts = new Map<string, number>();
        for (const a of deptAnomalies) {
          const reason = a.title || a.description;
          reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        }
        const topReasons = Array.from(reasonCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([reason]) => reason);

        return {
          name: dept.name,
          riskLevel,
          riskScore,
          atRiskCount,
          totalCount,
          topReasons,
        };
      });

      // Sort by risk score descending
      departmentRisks.sort((a, b) => b.riskScore - a.riskScore);

      return res.json({
        data: {
          departments: departmentRisks,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
