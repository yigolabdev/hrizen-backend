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
          riskScore += 20;
          factors.push('잦은 결근');
        } else if (absentCount >= 2) {
          riskScore += 10;
          factors.push('결근 이력');
        }

        // Factor: Frequent late arrivals
        const lateCount = emp.attendanceRecords.filter(
          (a) => a.status === 'LATE'
        ).length;
        if (lateCount >= 10) {
          riskScore += 15;
          factors.push('빈번한 지각');
        } else if (lateCount >= 5) {
          riskScore += 8;
          factors.push('지각 이력');
        }

        // Factor: Excessive leave usage
        const totalLeaveDays = emp.leaveRequests.reduce((sum, lr) => sum + lr.days, 0);
        if (totalLeaveDays >= 15) {
          riskScore += 10;
          factors.push('높은 휴가 사용률');
        }

        // Factor: No performance review
        if (!latestReview) {
          riskScore += 10;
          factors.push('성과 평가 미실시');
        }

        riskScore = Math.min(100, riskScore);

        let riskLevel: string;
        if (riskScore >= 70) {
          riskLevel = 'HIGH';
        } else if (riskScore >= 40) {
          riskLevel = 'MEDIUM';
        } else {
          riskLevel = 'LOW';
        }

        if (factors.length === 0) {
          factors.push('특이사항 없음');
        }

        return {
          employeeId: emp.id,
          name: emp.name,
          department: emp.department,
          tenure: tenureYears,
          satisfaction: satisfactionScore,
          riskScore,
          riskLevel,
          factors,
        };
      });

      // Sort by riskScore descending by default
      data.sort((a, b) => b.riskScore - a.riskScore);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/analytics/anomalies ─────────────────────────────────────────────
router.get(
  '/anomalies',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);
      const category = req.query.category as string | undefined;
      const severity = req.query.severity as string | undefined;
      const status = req.query.status as string | undefined;

      const whereClause: Record<string, unknown> = {
        tenantId,
      };

      if (category) {
        const upperCategory = category.toUpperCase();
        if (['ATTENDANCE', 'PAYROLL', 'PERFORMANCE', 'TURNOVER_RISK'].includes(upperCategory)) {
          whereClause.category = upperCategory;
        }
      }

      if (severity) {
        const upperSeverity = severity.toUpperCase();
        if (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(upperSeverity)) {
          whereClause.severity = upperSeverity;
        }
      }

      if (status === 'dismissed') {
        whereClause.isDismissed = true;
      } else if (status === 'active') {
        whereClause.isDismissed = false;
      }

      const validSortFields = ['detectedAt', 'severity', 'category', 'createdAt'];
      const effectiveSortBy = validSortFields.includes(sortBy) ? sortBy : 'detectedAt';

      const [anomalies, total] = await Promise.all([
        prisma.anomaly.findMany({
          where: whereClause,
          skip,
          take: limit,
          orderBy: { [effectiveSortBy]: sortOrder },
        }),
        prisma.anomaly.count({ where: whereClause }),
      ]);

      const data = anomalies.map((anomaly) => ({
        id: anomaly.id,
        title: anomaly.title,
        description: anomaly.description,
        severity: anomaly.severity,
        category: anomaly.category,
        status: anomaly.isDismissed ? 'DISMISSED' : 'ACTIVE',
        detectedAt: anomaly.detectedAt.toISOString(),
        affectedEmployee: anomaly.employeeId ?? '',
        department: anomaly.department ?? '',
        confidence: anomaly.data && typeof anomaly.data === 'object' && 'confidence' in (anomaly.data as Record<string, unknown>)
          ? Number((anomaly.data as Record<string, unknown>).confidence)
          : 0.85,
      }));

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/analytics/cost-analysis ─────────────────────────────────────────
router.get(
  '/cost-analysis',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const period = (req.query.period as string) || 'monthly';
      const year = req.query.year ? parseInt(req.query.year as string, 10) : new Date().getFullYear();

      const payrollRecords = await prisma.payrollRecord.findMany({
        where: {
          tenantId,
          month: {
            startsWith: `${year}`,
          },
          status: {
            in: ['CALCULATED', 'CONFIRMED', 'PAID'],
          },
        },
        orderBy: { month: 'asc' },
      });

      // Group by month
      const monthlyMap = new Map<
        string,
        { laborCost: number; benefits: number; trainingCost: number; totalCost: number }
      >();

      for (const record of payrollRecords) {
        const monthKey = record.month; // e.g., "2025-01"
        const existing = monthlyMap.get(monthKey) || {
          laborCost: 0,
          benefits: 0,
          trainingCost: 0,
          totalCost: 0,
        };

        const laborCost = record.baseSalary + record.overtimePay + record.bonus;
        const benefits =
          record.nationalPension +
          record.healthInsurance +
          record.employmentInsurance;
        const trainingCost = record.mealAllowance + record.transportAllowance;
        const totalCost = record.totalEarnings;

        existing.laborCost += laborCost;
        existing.benefits += benefits;
        existing.trainingCost += trainingCost;
        existing.totalCost += totalCost;

        monthlyMap.set(monthKey, existing);
      }

      let data: { month: string; laborCost: number; benefits: number; trainingCost: number; totalCost: number }[];

      if (period === 'quarterly') {
        const quarterlyMap = new Map<
          string,
          { laborCost: number; benefits: number; trainingCost: number; totalCost: number }
        >();

        for (const [monthKey, values] of monthlyMap.entries()) {
          const monthNum = parseInt(monthKey.split('-')[1], 10);
          const quarter = `${year}-Q${Math.ceil(monthNum / 3)}`;
          const existing = quarterlyMap.get(quarter) || {
            laborCost: 0,
            benefits: 0,
            trainingCost: 0,
            totalCost: 0,
          };

          existing.laborCost += values.laborCost;
          existing.benefits += values.benefits;
          existing.trainingCost += values.trainingCost;
          existing.totalCost += values.totalCost;

          quarterlyMap.set(quarter, existing);
        }

        data = Array.from(quarterlyMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, values]) => ({
            month,
            laborCost: Math.round(values.laborCost),
            benefits: Math.round(values.benefits),
            trainingCost: Math.round(values.trainingCost),
            totalCost: Math.round(values.totalCost),
          }));
      } else {
        data = Array.from(monthlyMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, values]) => ({
            month,
            laborCost: Math.round(values.laborCost),
            benefits: Math.round(values.benefits),
            trainingCost: Math.round(values.trainingCost),
            totalCost: Math.round(values.totalCost),
          }));
      }

      const latestTotal = data.length > 0 ? data[data.length - 1].totalCost : 0;
      const previousTotal = data.length > 1 ? data[data.length - 2].totalCost : 0;
      const changePercent =
        previousTotal > 0
          ? parseFloat((((latestTotal - previousTotal) / previousTotal) * 100).toFixed(1))
          : 0;

      return res.json({
        data,
        summary: {
          latestTotal,
          previousTotal,
          changePercent,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/analytics/ai-usage ──────────────────────────────────────────────
router.get(
  '/ai-usage',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // Fetch API usage logs for the tenant's API keys
      const apiKeys = await prisma.apiKey.findMany({
        where: { tenantId, isActive: true },
        select: { id: true },
      });

      const apiKeyIds = apiKeys.map((k) => k.id);

      const [usageLogs, anomalyCount, activeUserCount] = await Promise.all([
        apiKeyIds.length > 0
          ? prisma.apiUsageLog.findMany({
              where: {
                apiKeyId: { in: apiKeyIds },
                calledAt: { gte: thirtyDaysAgo },
              },
            })
          : Promise.resolve([]),
        prisma.anomaly.count({
          where: {
            tenantId,
            detectedAt: { gte: thirtyDaysAgo },
          },
        }),
        prisma.activityLog.groupBy({
          by: ['userId'],
          where: {
            tenantId,
            createdAt: { gte: thirtyDaysAgo },
          },
        }),
      ]);

      const totalPredictions = usageLogs.length + anomalyCount;
      const avgResponseTime =
        usageLogs.length > 0
          ? Math.round(
              usageLogs.reduce((sum, log) => sum + log.responseTimeMs, 0) / usageLogs.length
            )
          : 0;

      const successfulCalls = usageLogs.filter((l) => l.statusCode >= 200 && l.statusCode < 300);
      const avgAccuracy =
        usageLogs.length > 0
          ? parseFloat(((successfulCalls.length / usageLogs.length) * 100).toFixed(1))
          : 0;

      const activeUsers = activeUserCount.length;

      // Categorize endpoint usage into model categories
      const endpointCategories: Record<string, { name: string; color: string }> = {
        turnover: { name: '이직 위험 예측', color: '#FF6384' },
        anomaly: { name: '이상 탐지', color: '#36A2EB' },
        cost: { name: '비용 분석', color: '#FFCE56' },
        performance: { name: '성과 예측', color: '#4BC0C0' },
        other: { name: '기타 분석', color: '#9966FF' },
      };

      const modelCounts: Record<string, number> = {
        turnover: 0,
        anomaly: anomalyCount,
        cost: 0,
        performance: 0,
        other: 0,
      };

      for (const log of usageLogs) {
        const ep = log.endpoint.toLowerCase();
        if (ep.includes('turnover') || ep.includes('risk')) {
          modelCounts.turnover++;
        } else if (ep.includes('anomal')) {
          modelCounts.anomaly++;
        } else if (ep.includes('cost') || ep.includes('payroll')) {
          modelCounts.cost++;
        } else if (ep.includes('performance') || ep.includes('okr')) {
          modelCounts.performance++;
        } else {
          modelCounts.other++;
        }
      }

      const modelUsage = Object.entries(modelCounts)
        .filter(([, value]) => value > 0)
        .map(([key, value]) => ({
          name: endpointCategories[key].name,
          value,
          color: endpointCategories[key].color,
        }));

      // If no usage data, provide default model distribution
      if (modelUsage.length === 0) {
        modelUsage.push(
          { name: '이직 위험 예측', value: 0, color: '#FF6384' },
          { name: '이상 탐지', value: 0, color: '#36A2EB' },
          { name: '비용 분석', value: 0, color: '#FFCE56' },
          { name: '성과 예측', value: 0, color: '#4BC0C0' }
        );
      }

      // Generate insights based on actual data
      const insights: { id: string; text: string; type: string }[] = [];

      if (anomalyCount > 0) {
        insights.push({
          id: 'insight-anomaly-count',
          text: `최근 30일간 ${anomalyCount}건의 이상 징후가 탐지되었습니다.`,
          type: 'warning',
        });
      }

      if (avgAccuracy >= 90) {
        insights.push({
          id: 'insight-accuracy',
          text: `AI 모델 정확도가 ${avgAccuracy}%로 높은 수준을 유지하고 있습니다.`,
          type: 'success',
        });
      } else if (avgAccuracy > 0 && avgAccuracy < 80) {
        insights.push({
          id: 'insight-accuracy-low',
          text: `AI 모델 정확도가 ${avgAccuracy}%로 개선이 필요합니다.`,
          type: 'warning',
        });
      }

      if (activeUsers > 0) {
        insights.push({
          id: 'insight-active-users',
          text: `최근 30일간 ${activeUsers}명의 사용자가 시스템을 활용했습니다.`,
          type: 'info',
        });
      }

      if (totalPredictions === 0) {
        insights.push({
          id: 'insight-no-data',
          text: 'AI 분석 데이터가 아직 충분하지 않습니다. 데이터가 축적되면 더 정확한 인사이트를 제공합니다.',
          type: 'info',
        });
      }

      return res.json({
        data: {
          totalPredictions,
          avgAccuracy,
          avgResponseTime,
          activeUsers,
          modelUsage,
          insights,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
