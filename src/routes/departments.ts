import { Router, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authenticate, authorize, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';

const router = Router();

// GET /api/departments — 부서 목록 조회
router.get(
  '/',
  authenticate,
  authorize('admin', 'hr_manager'),
  async (req: AuthRequest, res: Response, next) => {
    try {
      const tenantId = req.user!.tenantId;
      const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);

      const searchQuery = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

      const whereClause = {
        tenantId,
        deletedAt: null,
        ...(searchQuery
          ? {
              name: {
                contains: searchQuery,
                mode: 'insensitive' as const,
              },
            }
          : {}),
      };

      const validSortFields = ['name', 'employeeCount', 'createdAt', 'updatedAt'];
      const resolvedSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

      const [data, total] = await Promise.all([
        prisma.department.findMany({
          where: whereClause,
          skip,
          take: limit,
          orderBy: { [resolvedSortBy]: sortOrder },
          select: {
            id: true,
            name: true,
            managerId: true,
            employeeCount: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.department.count({ where: whereClause }),
      ]);

      return res.json(paginatedResponse(data, total, page, limit));
    } catch (err) {
      next(err);
    }
  }
);

export default router;
