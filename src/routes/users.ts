import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import bcrypt from 'bcrypt';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const createUserSchema = z.object({
  body: z.object({
    email: z.string().email('유효한 이메일 주소를 입력하세요'),
    password: z.string().min(8, '비밀번호는 최소 8자 이상이어야 합니다'),
    name: z.string().min(1, '이름은 필수입니다').max(100),
    role: z.enum(['USER', 'ADMIN'], { errorMap: () => ({ message: '역할은 USER 또는 ADMIN이어야 합니다' }) }),
    department: z.string().optional(),
    position: z.string().optional(),
    tenantId: z.string().min(1, 'tenantId는 필수입니다'),
  }),
});

const updateUserSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    role: z.enum(['USER', 'ADMIN']).optional(),
    department: z.string().optional(),
    position: z.string().optional(),
    permissions: z.array(z.string()).optional(),
  }),
});

// ─── GET /api/users — 사용자 목록 조회 ───────────────────

router.get(
  '/',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);

      const roleFilter = req.query.role as string | undefined;
      const departmentFilter = req.query.department as string | undefined;

      const where: Record<string, unknown> = {
        tenantId: req.user!.tenantId,
        deletedAt: null,
      };

      if (roleFilter) {
        const upperRole = roleFilter.toUpperCase();
        if (upperRole === 'USER' || upperRole === 'ADMIN') {
          where.role = upperRole;
        }
      }

      if (departmentFilter) {
        where.department = departmentFilter;
      }

      const allowedSortFields = ['createdAt', 'name', 'email', 'role', 'department', 'updatedAt'];
      const resolvedSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';

      const [data, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [resolvedSortBy]: sortOrder },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            phone: true,
            department: true,
            position: true,
            avatarUrl: true,
            twoFactorEnabled: true,
            isActive: true,
            lastPasswordChange: true,
            createdAt: true,
            updatedAt: true,
            tenantId: true,
          },
        }),
        prisma.user.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/users/:userId — 특정 사용자 상세 조회 ──────

router.get(
  '/:userId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;

      const user = await prisma.user.findFirst({
        where: {
          id: userId,
          tenantId: req.user!.tenantId,
          deletedAt: null,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          phone: true,
          department: true,
          position: true,
          avatarUrl: true,
          twoFactorEnabled: true,
          isActive: true,
          lastPasswordChange: true,
          createdAt: true,
          updatedAt: true,
          tenantId: true,
          employee: {
            select: {
              id: true,
              employeeNumber: true,
              department: true,
              position: true,
              hireDate: true,
              employmentType: true,
              status: true,
            },
          },
          notificationSettings: true,
        },
      });

      if (!user) {
        throw Object.assign(new Error('사용자를 찾을 수 없습니다'), { status: 404 });
      }

      return res.json({ data: user });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/users — 새 사용자 생성 ───────────────────

router.post(
  '/',
  authenticate,
  authorize('admin'),
  validate(createUserSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email, password, name, role, department, position, tenantId } = req.body;

      // 요청자의 테넌트와 일치하는지 확인
      if (tenantId !== req.user!.tenantId) {
        throw Object.assign(new Error('다른 테넌트에 사용자를 생성할 수 없습니다'), { status: 403 });
      }

      // 이메일 중복 확인
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        throw Object.assign(new Error('이미 사용 중인 이메일입니다'), { status: 409 });
      }

      // 테넌트 사용자 수 제한 확인
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { userCount: true, maxUsers: true },
      });

      if (!tenant) {
        throw Object.assign(new Error('테넌트를 찾을 수 없습니다'), { status: 404 });
      }

      if (tenant.userCount >= tenant.maxUsers) {
        throw Object.assign(new Error('테넌트의 최대 사용자 수에 도달했습니다'), { status: 403 });
      }

      const SALT_ROUNDS = 12;
      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

      const [newUser] = await prisma.$transaction([
        prisma.user.create({
          data: {
            email,
            password: hashedPassword,
            name,
            role: role as 'USER' | 'ADMIN',
            department,
            position,
            tenantId,
          },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            phone: true,
            department: true,
            position: true,
            avatarUrl: true,
            twoFactorEnabled: true,
            isActive: true,
            lastPasswordChange: true,
            createdAt: true,
            updatedAt: true,
            tenantId: true,
          },
        }),
        prisma.tenant.update({
          where: { id: tenantId },
          data: { userCount: { increment: 1 } },
        }),
      ]);

      return res.status(201).json({ data: newUser });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/users/:userId — 사용자 정보 수정 ──────────

router.put(
  '/:userId',
  authenticate,
  authorize('admin'),
  validate(updateUserSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const { name, role, department, position } = req.body;

      // 대상 사용자 존재 확인 (같은 테넌트)
      const existingUser = await prisma.user.findFirst({
        where: {
          id: userId,
          tenantId: req.user!.tenantId,
          deletedAt: null,
        },
      });

      if (!existingUser) {
        throw Object.assign(new Error('사용자를 찾을 수 없습니다'), { status: 404 });
      }

      const updateData: Record<string, unknown> = {};

      if (name !== undefined) updateData.name = name;
      if (role !== undefined) updateData.role = role as 'USER' | 'ADMIN';
      if (department !== undefined) updateData.department = department;
      if (position !== undefined) updateData.position = position;

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: updateData,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          phone: true,
          department: true,
          position: true,
          avatarUrl: true,
          twoFactorEnabled: true,
          isActive: true,
          lastPasswordChange: true,
          createdAt: true,
          updatedAt: true,
          tenantId: true,
        },
      });

      return res.json({ data: updatedUser });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/users/:userId — 사용자 삭제 (비활성화) ──

router.delete(
  '/:userId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;

      // 자기 자신은 삭제 불가
      if (userId === req.user!.id) {
        throw Object.assign(new Error('자기 자신을 삭제할 수 없습니다'), { status: 400 });
      }

      const existingUser = await prisma.user.findFirst({
        where: {
          id: userId,
          tenantId: req.user!.tenantId,
          deletedAt: null,
        },
      });

      if (!existingUser) {
        throw Object.assign(new Error('사용자를 찾을 수 없습니다'), { status: 404 });
      }

      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: {
            isActive: false,
            deletedAt: new Date(),
          },
        }),
        prisma.refreshToken.updateMany({
          where: { userId },
          data: { isRevoked: true },
        }),
        prisma.tenant.update({
          where: { id: req.user!.tenantId },
          data: { userCount: { decrement: 1 } },
        }),
      ]);

      return res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
