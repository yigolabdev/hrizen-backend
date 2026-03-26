import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import bcrypt from 'bcryptjs';

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

// ─── GET /api/users/:userId — 사용자 상세 조회 ──────────

router.get(
  '/:userId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: {
          id: req.params.userId,
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
          permissions: true,
          createdAt: true,
          updatedAt: true,
          tenantId: true,
        },
      });

      if (!user) {
        res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
        return;
      }

      return res.json({ data: user });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/users — 사용자 생성 ──────────────────────

router.post(
  '/',
  authenticate,
  authorize('admin'),
  validate(createUserSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email, password, name, role, department, position, tenantId } = req.body;

      const hashedPassword = await bcrypt.hash(password, 12);

      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          role,
          department: department || null,
          position: position || null,
          tenantId,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          department: true,
          position: true,
          tenantId: true,
          createdAt: true,
        },
      });

      return res.status(201).json({ data: user });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/users/:userId — 사용자 수정 ───────────────

router.put(
  '/:userId',
  authenticate,
  authorize('admin'),
  validate(updateUserSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.update({
        where: {
          id: req.params.userId,
          tenantId: req.user!.tenantId,
          deletedAt: null,
        },
        data: req.body,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          department: true,
          position: true,
          permissions: true,
          tenantId: true,
          updatedAt: true,
        },
      });

      return res.json({ data: user });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/users/:userId — 사용자 삭제 (소프트) ────

router.delete(
  '/:userId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await prisma.user.update({
        where: {
          id: req.params.userId,
          tenantId: req.user!.tenantId,
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });

      return res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
