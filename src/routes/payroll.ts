import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const calculatePayrollSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be in YYYY-MM format'),
  departmentIds: z.array(z.string().min(1)).optional(),
});

const updatePayrollSchema = z.object({
  baseSalary: z.number().min(0).optional(),
  overtimePay: z.number().min(0).optional(),
  bonus: z.number().min(0).optional(),
  deductions: z
    .object({
      mealAllowance: z.number().min(0).optional(),
      transportAllowance: z.number().min(0).optional(),
      nationalPension: z.number().min(0).optional(),
      healthInsurance: z.number().min(0).optional(),
      employmentInsurance: z.number().min(0).optional(),
      incomeTax: z.number().min(0).optional(),
      localIncomeTax: z.number().min(0).optional(),
    })
    .optional(),
});

// ─── Helper: Recalculate totals ──────────────────────────

function recalculateTotals(record: {
  baseSalary: number;
  overtimePay: number;
  bonus: number;
  mealAllowance: number;
  transportAllowance: number;
  nationalPension: number;
  healthInsurance: number;
  employmentInsurance: number;
  incomeTax: number;
  localIncomeTax: number;
}) {
  const totalEarnings =
    record.baseSalary +
    record.overtimePay +
    record.bonus +
    record.mealAllowance +
    record.transportAllowance;

  const totalDeductions =
    record.nationalPension +
    record.healthInsurance +
    record.employmentInsurance +
    record.incomeTax +
    record.localIncomeTax;

  const netPay = totalEarnings - totalDeductions;

  return { totalEarnings, totalDeductions, netPay };
}

// ─── GET /api/payroll — 급여 정산 목록 조회 ──────────────

router.get(
  '/',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);
      const tenantId = req.user!.tenantId;

      const month = typeof req.query.month === 'string' ? req.query.month : undefined;
      const department =
        typeof req.query.department === 'string' ? req.query.department : undefined;
      const status =
        typeof req.query.status === 'string' ? req.query.status : undefined;

      const where: Record<string, unknown> = { tenantId };

      if (month) {
        where.month = month;
      }

      if (department) {
        where.employee = { department };
      }

      if (status) {
        where.status = status;
      }

      const [data, total] = await Promise.all([
        prisma.payrollRecord.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [sortBy]: sortOrder },
          include: {
            employee: {
              select: {
                id: true,
                employeeNumber: true,
                name: true,
                department: true,
                position: true,
              },
            },
          },
        }),
        prisma.payrollRecord.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/payroll/calculate — 급여 일괄 계산 실행 ───

router.post(
  '/calculate',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(calculatePayrollSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { month, departmentIds } = req.body as z.infer<typeof calculatePayrollSchema>;

      // Find target employees
      const employeeWhere: Record<string, unknown> = {
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
      };

      if (departmentIds && departmentIds.length > 0) {
        // Resolve department names from IDs
        const departments = await prisma.department.findMany({
          where: {
            id: { in: departmentIds },
            tenantId,
            deletedAt: null,
          },
          select: { name: true },
        });
        const departmentNames = departments.map((d) => d.name);
        employeeWhere.department = { in: departmentNames };
      }

      const employees = await prisma.employee.findMany({
        where: employeeWhere,
        select: {
          id: true,
          salary: true,
          name: true,
        },
      });

      if (employees.length === 0) {
        const error = Object.assign(new Error('No active employees found for the given criteria'), {
          status: 404,
        });
        throw error;
      }

      // Check for existing records for this month to avoid duplicates
      const existingRecords = await prisma.payrollRecord.findMany({
        where: {
          tenantId,
          month,
          employeeId: { in: employees.map((e) => e.id) },
        },
        select: { employeeId: true },
      });

      const existingEmployeeIds = new Set(existingRecords.map((r) => r.employeeId));
      const newEmployees = employees.filter((e) => !existingEmployeeIds.has(e.id));

      // Calculate payroll for each employee
      const payrollData = newEmployees.map((employee) => {
        const baseSalary = employee.salary;
        const overtimePay = 0;
        const bonus = 0;
        const mealAllowance = 100000;
        const transportAllowance = 100000;

        const totalEarnings =
          baseSalary + overtimePay + bonus + mealAllowance + transportAllowance;

        // Korean statutory deductions (approximate rates)
        const nationalPension = Math.round(baseSalary * 0.045);
        const healthInsurance = Math.round(baseSalary * 0.03545);
        const employmentInsurance = Math.round(baseSalary * 0.009);
        const incomeTax = Math.round(totalEarnings * 0.06);
        const localIncomeTax = Math.round(incomeTax * 0.1);

        const totalDeductions =
          nationalPension +
          healthInsurance +
          employmentInsurance +
          incomeTax +
          localIncomeTax;

        const netPay = totalEarnings - totalDeductions;

        return {
          month,
          baseSalary,
          overtimePay,
          bonus,
          mealAllowance,
          transportAllowance,
          nationalPension,
          healthInsurance,
          employmentInsurance,
          incomeTax,
          localIncomeTax,
          totalEarnings,
          totalDeductions,
          netPay,
          status: 'CALCULATED' as const,
          employeeId: employee.id,
          tenantId,
        };
      });

      if (payrollData.length > 0) {
        await prisma.payrollRecord.createMany({ data: payrollData });
      }

      const jobId = `payroll-${month}-${Date.now()}`;

      return res.status(201).json({
        data: {
          jobId,
          status: 'completed',
          message: `Payroll calculated for ${payrollData.length} employees (${existingEmployeeIds.size} already existed). Month: ${month}`,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/payroll/payslips — 급여 명세서 목록 (본인용) ─

router.get(
  '/payslips',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);
      const userId = req.user!.id;
      const tenantId = req.user!.tenantId;

      // Find the employee linked to this user
      const employee = await prisma.employee.findFirst({
        where: { userId, tenantId, deletedAt: null },
        select: { id: true },
      });

      if (!employee) {
        const error = Object.assign(
          new Error('Employee record not found for the current user'),
          { status: 404 }
        );
        throw error;
      }

      const where = {
        employeeId: employee.id,
        tenantId,
        status: { in: ['CONFIRMED' as const, 'PAID' as const] },
      };

      const [data, total] = await Promise.all([
        prisma.payrollRecord.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [sortBy]: sortOrder },
          select: {
            id: true,
            month: true,
            baseSalary: true,
            overtimePay: true,
            bonus: true,
            mealAllowance: true,
            transportAllowance: true,
            totalEarnings: true,
            totalDeductions: true,
            netPay: true,
            payDate: true,
            status: true,
          },
        }),
        prisma.payrollRecord.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/payroll/payslips/:month — 특정 월 급여 명세서 상세 (본인용) ─

router.get(
  '/payslips/:month',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const tenantId = req.user!.tenantId;
      const { month } = req.params;

      const employee = await prisma.employee.findFirst({
        where: { userId, tenantId, deletedAt: null },
        select: { id: true },
      });

      if (!employee) {
        const error = Object.assign(
          new Error('Employee record not found for the current user'),
          { status: 404 }
        );
        throw error;
      }

      const payslip = await prisma.payrollRecord.findFirst({
        where: {
          employeeId: employee.id,
          tenantId,
          month,
          status: { in: ['CONFIRMED', 'PAID'] },
        },
        include: {
          employee: {
            select: {
              employeeNumber: true,
              name: true,
              department: true,
              position: true,
            },
          },
        },
      });

      if (!payslip) {
        const error = Object.assign(
          new Error(`Payslip not found for month: ${month}`),
          { status: 404 }
        );
        throw error;
      }

      return res.json({ data: payslip });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/payroll/payslips/:month/download — 급여 명세서 PDF 다운로드 ─

router.get(
  '/payslips/:month/download',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const tenantId = req.user!.tenantId;
      const { month } = req.params;

      const employee = await prisma.employee.findFirst({
        where: { userId, tenantId, deletedAt: null },
        select: { id: true, name: true, employeeNumber: true },
      });

      if (!employee) {
        const error = Object.assign(
          new Error('Employee record not found for the current user'),
          { status: 404 }
        );
        throw error;
      }

      const payslip = await prisma.payrollRecord.findFirst({
        where: {
          employeeId: employee.id,
          tenantId,
          month,
          status: { in: ['CONFIRMED', 'PAID'] },
        },
        include: {
          employee: {
            select: {
              employeeNumber: true,
              name: true,
              department: true,
              position: true,
            },
          },
        },
      });

      if (!payslip) {
        const error = Object.assign(
          new Error(`Payslip not found for month: ${month}`),
          { status: 404 }
        );
        throw error;
      }

      // Generate a simple PDF-like content
      // In production, use a library like PDFKit, Puppeteer, or a template engine
      const pdfContent = Buffer.from(
        `%PDF-1.4\n` +
          `HRiZen - 급여 명세서\n` +
          `================================\n` +
          `기간: ${payslip.month}\n` +
          `사원번호: ${payslip.employee.employeeNumber}\n` +
          `성명: ${payslip.employee.name}\n` +
          `부서: ${payslip.employee.department}\n` +
          `직위: ${payslip.employee.position}\n` +
          `================================\n` +
          `[지급 항목]\n` +
          `기본급: ${payslip.baseSalary.toLocaleString()}원\n` +
          `연장근로수당: ${payslip.overtimePay.toLocaleString()}원\n` +
          `상여금: ${payslip.bonus.toLocaleString()}원\n` +
          `식대: ${payslip.mealAllowance.toLocaleString()}원\n` +
          `교통비: ${payslip.transportAllowance.toLocaleString()}원\n` +
          `지급 합계: ${payslip.totalEarnings.toLocaleString()}원\n` +
          `================================\n` +
          `[공제 항목]\n` +
          `국민연금: ${payslip.nationalPension.toLocaleString()}원\n` +
          `건강보험: ${payslip.healthInsurance.toLocaleString()}원\n` +
          `고용보험: ${payslip.employmentInsurance.toLocaleString()}원\n` +
          `소득세: ${payslip.incomeTax.toLocaleString()}원\n` +
          `지방소득세: ${payslip.localIncomeTax.toLocaleString()}원\n` +
          `공제 합계: ${payslip.totalDeductions.toLocaleString()}원\n` +
          `================================\n` +
          `실수령액: ${payslip.netPay.toLocaleString()}원\n`,
        'utf-8'
      );

      const filename = `payslip_${employee.employeeNumber}_${month}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', pdfContent.length);

      return res.send(pdfContent);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/payroll/:payrollId — 급여 정산 상세 조회 ────

router.get(
  '/:payrollId',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { payrollId } = req.params;

      const payrollRecord = await prisma.payrollRecord.findFirst({
        where: {
          id: payrollId,
          tenantId,
        },
        include: {
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              name: true,
              email: true,
              department: true,
              position: true,
              hireDate: true,
              salary: true,
              employmentType: true,
              status: true,
            },
          },
        },
      });

      if (!payrollRecord) {
        const error = Object.assign(
          new Error(`Payroll record not found: ${payrollId}`),
          { status: 404 }
        );
        throw error;
      }

      return res.json({ data: payrollRecord });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/payroll/:payrollId — 급여 정산 항목 수정 ────

router.put(
  '/:payrollId',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(updatePayrollSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { payrollId } = req.params;
      const body = req.body as z.infer<typeof updatePayrollSchema>;

      const existing = await prisma.payrollRecord.findFirst({
        where: { id: payrollId, tenantId },
      });

      if (!existing) {
        const error = Object.assign(
          new Error(`Payroll record not found: ${payrollId}`),
          { status: 404 }
        );
        throw error;
      }

      // Cannot modify confirmed or paid records
      if (existing.status === 'CONFIRMED' || existing.status === 'PAID') {
        const error = Object.assign(
          new Error(`Cannot modify payroll record with status: ${existing.status}`),
          { status: 400 }
        );
        throw error;
      }

      // Build update data
      const updateData: Record<string, unknown> = {};

      if (body.baseSalary !== undefined) {
        updateData.baseSalary = body.baseSalary;
      }
      if (body.overtimePay !== undefined) {
        updateData.overtimePay = body.overtimePay;
      }
      if (body.bonus !== undefined) {
        updateData.bonus = body.bonus;
      }

      if (body.deductions) {
        if (body.deductions.mealAllowance !== undefined) {
          updateData.mealAllowance = body.deductions.mealAllowance;
        }
        if (body.deductions.transportAllowance !== undefined) {
          updateData.transportAllowance = body.deductions.transportAllowance;
        }
        if (body.deductions.nationalPension !== undefined) {
          updateData.nationalPension = body.deductions.nationalPension;
        }
        if (body.deductions.healthInsurance !== undefined) {
          updateData.healthInsurance = body.deductions.healthInsurance;
        }
        if (body.deductions.employmentInsurance !== undefined) {
          updateData.employmentInsurance = body.deductions.employmentInsurance;
        }
        if (body.deductions.incomeTax !== undefined) {
          updateData.incomeTax = body.deductions.incomeTax;
        }
        if (body.deductions.localIncomeTax !== undefined) {
          updateData.localIncomeTax = body.deductions.localIncomeTax;
        }
      }

      // Merge with existing values and recalculate totals
      const merged = {
        baseSalary: (updateData.baseSalary as number) ?? existing.baseSalary,
        overtimePay: (updateData.overtimePay as number) ?? existing.overtimePay,
        bonus: (updateData.bonus as number) ?? existing.bonus,
        mealAllowance: (updateData.mealAllowance as number) ?? existing.mealAllowance,
        transportAllowance:
          (updateData.transportAllowance as number) ?? existing.transportAllowance,
        nationalPension:
          (updateData.nationalPension as number) ?? existing.nationalPension,
        healthInsurance:
          (updateData.healthInsurance as number) ?? existing.healthInsurance,
        employmentInsurance:
          (updateData.employmentInsurance as number) ?? existing.employmentInsurance,
        incomeTax: (updateData.incomeTax as number) ?? existing.incomeTax,
        localIncomeTax:
          (updateData.localIncomeTax as number) ?? existing.localIncomeTax,
      };

      const { totalEarnings, totalDeductions, netPay } = recalculateTotals(merged);

      const updated = await prisma.payrollRecord.update({
        where: { id: payrollId },
        data: {
          ...updateData,
          totalEarnings,
          totalDeductions,
          netPay,
        },
        include: {
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              name: true,
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

// ─── POST /api/payroll/:payrollId/confirm — 급여 정산 확정 ─

router.post(
  '/:payrollId/confirm',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { payrollId } = req.params;

      const existing = await prisma.payrollRecord.findFirst({
        where: { id: payrollId, tenantId },
      });

      if (!existing) {
        const error = Object.assign(
          new Error(`Payroll record not found: ${payrollId}`),
          { status: 404 }
        );
        throw error;
      }

      if (existing.status === 'CONFIRMED' || existing.status === 'PAID') {
        const error = Object.assign(
          new Error(`Payroll record is already ${existing.status.toLowerCase()}`),
          { status: 400 }
        );
        throw error;
      }

      if (existing.status === 'DRAFT') {
        const error = Object.assign(
          new Error('Payroll record must be calculated before confirmation'),
          { status: 400 }
        );
        throw error;
      }

      const payDate = new Date();

      await prisma.payrollRecord.update({
        where: { id: payrollId },
        data: {
          status: 'CONFIRMED',
          payDate,
        },
      });

      return res.json({
        data: {
          success: true,
          payDate: payDate.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
