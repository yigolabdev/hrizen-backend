import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const createEmployeeSchema = z.object({
  body: z.object({
    name: z.string().min(1, '이름은 필수입니다').max(100),
    email: z.string().email('유효한 이메일 주소를 입력하세요'),
    department: z.string().min(1, '부서는 필수입니다').max(100),
    position: z.string().min(1, '직위는 필수입니다').max(100),
    hireDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: '유효한 날짜 형식이어야 합니다 (예: 2024-01-15)',
    }),
    salary: z.number().positive('급여는 양수여야 합니다'),
    employmentType: z.string().min(1, '고용 유형은 필수입니다').max(50),
  }),
});

const updateEmployeeSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    department: z.string().min(1).max(100).optional(),
    position: z.string().min(1).max(100).optional(),
    salary: z.number().positive('급여는 양수여야 합니다').optional(),
    status: z.enum(['ACTIVE', 'ON_LEAVE', 'RESIGNED', 'TERMINATED']).optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: '최소 하나의 수정 필드가 필요합니다',
  }),
});

const terminateEmployeeSchema = z.object({
  body: z.object({
    terminationDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: '유효한 날짜 형식이어야 합니다 (예: 2024-01-15)',
    }),
    reason: z.string().max(500).optional(),
  }),
});

// ─── Helper: Generate Employee Number ────────────────────

async function generateEmployeeNumber(tenantId: string): Promise<string> {
  const count = await prisma.employee.count({ where: { tenantId } });
  const nextNumber = count + 1;
  return `EMP-${String(nextNumber).padStart(6, '0')}`;
}

// ─── GET /api/employees ──────────────────────────────────
// 직원 목록 조회 (부서/상태 필터, 페이지네이션)

router.get(
  '/',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);

      const department = req.query.department as string | undefined;
      const status = req.query.status as string | undefined;

      const where: Record<string, unknown> = {
        tenantId,
        deletedAt: null,
      };

      if (department) {
        where.department = department;
      }

      if (status) {
        const validStatuses = ['ACTIVE', 'ON_LEAVE', 'RESIGNED', 'TERMINATED'];
        if (validStatuses.includes(status.toUpperCase())) {
          where.status = status.toUpperCase();
        }
      }

      const allowedSortFields = ['name', 'department', 'position', 'hireDate', 'salary', 'status', 'createdAt'];
      const resolvedSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';

      const [data, total] = await Promise.all([
        prisma.employee.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [resolvedSortBy]: sortOrder },
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
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.employee.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/employees/:employeeId ──────────────────────
// 직원 상세 정보 조회

router.get(
  '/:employeeId',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId } = req.params;

      const employee = await prisma.employee.findFirst({
        where: {
          id: employeeId,
          tenantId,
          deletedAt: null,
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
              phone: true,
              avatarUrl: true,
              isActive: true,
            },
          },
        },
      });

      if (!employee) {
        throw Object.assign(new Error('직원을 찾을 수 없습니다'), { status: 404 });
      }

      return res.json({ data: employee });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/employees ─────────────────────────────────
// 신규 직원 등록 (온보딩)

router.post(
  '/',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(createEmployeeSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { name, email, department, position, hireDate, salary, employmentType } = req.body;

      // 이메일 중복 확인 (같은 테넌트 내)
      const existingEmployee = await prisma.employee.findFirst({
        where: {
          email,
          tenantId,
          deletedAt: null,
        },
      });

      if (existingEmployee) {
        throw Object.assign(new Error('이미 등록된 이메일 주소입니다'), { status: 409 });
      }

      const employeeNumber = await generateEmployeeNumber(tenantId);

      const employee = await prisma.employee.create({
        data: {
          employeeNumber,
          name,
          email,
          department,
          position,
          hireDate: new Date(hireDate),
          salary,
          employmentType,
          status: 'ACTIVE',
          tenantId,
        },
      });

      return res.status(201).json({ data: employee });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/employees/:employeeId ──────────────────────
// 직원 정보 수정

router.put(
  '/:employeeId',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(updateEmployeeSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId } = req.params;
      const { name, department, position, salary, status } = req.body;

      const existingEmployee = await prisma.employee.findFirst({
        where: {
          id: employeeId,
          tenantId,
          deletedAt: null,
        },
      });

      if (!existingEmployee) {
        throw Object.assign(new Error('직원을 찾을 수 없습니다'), { status: 404 });
      }

      const updateData: Record<string, unknown> = {};
      if (name !== undefined) updateData.name = name;
      if (department !== undefined) updateData.department = department;
      if (position !== undefined) updateData.position = position;
      if (salary !== undefined) updateData.salary = salary;
      if (status !== undefined) updateData.status = status;

      const updatedEmployee = await prisma.employee.update({
        where: { id: employeeId },
        data: updateData,
      });

      return res.json({ data: updatedEmployee });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/employees/:employeeId ───────────────────
// 직원 퇴사 처리 (비활성화 - 소프트 삭제)

router.delete(
  '/:employeeId',
  authenticate,
  authorize('admin', 'hr_manager'),
  validate(terminateEmployeeSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.user!.tenantId;
      const { employeeId } = req.params;
      const { terminationDate, reason } = req.body;

      const existingEmployee = await prisma.employee.findFirst({
        where: {
          id: employeeId,
          tenantId,
          deletedAt: null,
        },
      });

      if (!existingEmployee) {
        throw Object.assign(new Error('직원을 찾을 수 없습니다'), { status: 404 });
      }

      if (existingEmployee.status === 'TERMINATED' || existingEmployee.status === 'RESIGNED') {
        throw Object.assign(new Error('이미 퇴사 처리된 직원입니다'), { status: 409 });
      }

      await prisma.employee.update({
        where: { id: employeeId },
        data: {
          status: 'TERMINATED',
          deletedAt: new Date(terminationDate),
        },
      });

      // 연결된 사용자 계정 비활성화
      if (existingEmployee.userId) {
        await prisma.user.update({
          where: { id: existingEmployee.userId },
          data: { isActive: false },
        });
      }

      // 퇴사 사유가 있으면 활동 로그에 기록
      if (reason) {
        await prisma.activityLog.create({
          data: {
            action: 'DELETE',
            resource: 'Employee',
            resourceId: employeeId,
            description: `직원 퇴사 처리: ${existingEmployee.name} - 사유: ${reason}`,
            userId: req.user!.userId,
            tenantId,
          },
        });
      }

      return res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
