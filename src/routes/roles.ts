import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const createRoleSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(1, 'Role name is required')
      .max(100, 'Role name must be 100 characters or less')
      .trim(),
    permissions: z
      .array(z.string().min(1, 'Permission must be a non-empty string'))
      .min(1, 'At least one permission is required'),
  }),
});

const updateRoleSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(1, 'Role name must be non-empty')
      .max(100, 'Role name must be 100 characters or less')
      .trim()
      .optional(),
    permissions: z
      .array(z.string().min(1, 'Permission must be a non-empty string'))
      .min(1, 'At least one permission is required')
      .optional(),
  }).refine(
    (data) => data.name !== undefined || data.permissions !== undefined,
    { message: 'At least one field (name or permissions) must be provided' }
  ),
});

// ─── GET /api/roles — 역할 목록 조회 ─────────────────────

router.get(
  '/',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);
      const tenantId = req.user!.tenantId;

      const where = { tenantId, deletedAt: null };

      const validSortFields = ['name', 'createdAt', 'updatedAt'];
      const orderByField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

      const [data, total] = await Promise.all([
        prisma.customRole.findMany({
          where,
          skip,
          take: limit,
          orderBy: { [orderByField]: sortOrder },
        }),
        prisma.customRole.count({ where }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/roles — 새 역할 생성 ─────────────────────

router.post(
  '/',
  authenticate,
  authorize('admin'),
  validate(createRoleSchema),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { name, permissions } = req.body as { name: string; permissions: string[] };

      // Check for duplicate role name within the same tenant
      const existing = await prisma.customRole.findFirst({
        where: { tenantId, name, deletedAt: null },
      });

      if (existing) {
        const error = Object.assign(new Error('A role with this name already exists'), {
          status: 409,
        });
        throw error;
      }

      const role = await prisma.customRole.create({
        data: {
          name,
          permissions,
          tenantId,
        },
      });

      return res.status(201).json({ data: role });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/roles/:roleId — 역할 수정 ─────────────────

router.put(
  '/:roleId',
  authenticate,
  authorize('admin'),
  validate(updateRoleSchema),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { roleId } = req.params;
      const { name, permissions } = req.body as {
        name?: string;
        permissions?: string[];
      };

      // Verify the role exists and belongs to the tenant
      const existingRole = await prisma.customRole.findFirst({
        where: { id: roleId, tenantId, deletedAt: null },
      });

      if (!existingRole) {
        throw Object.assign(new Error('Role not found'), { status: 404 });
      }

      // If name is being changed, check for duplicates
      if (name && name !== existingRole.name) {
        const duplicate = await prisma.customRole.findFirst({
          where: {
            tenantId,
            name,
            deletedAt: null,
            id: { not: roleId },
          },
        });

        if (duplicate) {
          throw Object.assign(
            new Error('A role with this name already exists'),
            { status: 409 }
          );
        }
      }

      const updateData: Record<string, unknown> = {};
      if (name !== undefined) updateData.name = name;
      if (permissions !== undefined) updateData.permissions = permissions;

      const updatedRole = await prisma.customRole.update({
        where: { id: roleId },
        data: updateData,
      });

      return res.json({ data: updatedRole });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/roles/:roleId — 역할 삭제 ──────────────

router.delete(
  '/:roleId',
  authenticate,
  authorize('admin'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { roleId } = req.params;

      // Verify the role exists and belongs to the tenant
      const existingRole = await prisma.customRole.findFirst({
        where: { id: roleId, tenantId, deletedAt: null },
      });

      if (!existingRole) {
        throw Object.assign(new Error('Role not found'), { status: 404 });
      }

      // Soft delete
      await prisma.customRole.update({
        where: { id: roleId },
        data: { deletedAt: new Date() },
      });

      return res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
