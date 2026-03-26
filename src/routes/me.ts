import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { validate } from '../middleware/validate.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';

const router = Router();

// ─── Zod Schemas ─────────────────────────────────────────

const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    phone: z.string().min(1).max(30).optional(),
    department: z.string().min(1).max(100).optional(),
    position: z.string().min(1).max(100).optional(),
  }),
});

const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(128),
  }),
});

const updateSecuritySchema = z.object({
  body: z.object({
    twoFactorEnabled: z.boolean(),
  }),
});

const updateNotificationSettingsSchema = z.object({
  body: z.object({
    emailAlerts: z.boolean().optional(),
    smsAlerts: z.boolean().optional(),
    pushAlerts: z.boolean().optional(),
  }),
});

// ─── Multer Configuration ────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, 'uploads/avatars');
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = crypto.randomUUID();
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (jpg, jpeg, png, gif, webp) are allowed'));
    }
  },
});

// ─── GET /api/me — 현재 로그인된 사용자 프로필 조회 ──────

router.get('/', authenticate, async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        department: true,
        position: true,
        avatarUrl: true,
        role: true,
        tenantId: true,
      },
    });

    if (!user) {
      throw Object.assign(new Error('User not found'), { status: 404 });
    }

    return res.json({ data: user });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/me — 현재 사용자 프로필 수정 ───────────────

router.put('/', authenticate, validate(updateProfileSchema), async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;
    const { name, phone, department, position } = req.body as z.infer<typeof updateProfileSchema>['body'];

    const existingUser = await prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
    });

    if (!existingUser) {
      throw Object.assign(new Error('User not found'), { status: 404 });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(department !== undefined && { department }),
        ...(position !== undefined && { position }),
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        department: true,
        position: true,
        avatarUrl: true,
        role: true,
        tenantId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({ data: updatedUser });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/me/avatar — 프로필 아바타 이미지 업로드 ───

router.post('/avatar', authenticate, upload.single('avatar'), async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;

    if (!req.file) {
      throw Object.assign(new Error('Avatar file is required'), { status: 400 });
    }

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;

    await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });

    return res.status(201).json({ data: { avatarUrl } });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/me/password — 비밀번호 변경 ────────────────

router.put('/password', authenticate, validate(changePasswordSchema), async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>['body'];

    const user = await prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
    });

    if (!user) {
      throw Object.assign(new Error('User not found'), { status: 404 });
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordValid) {
      throw Object.assign(new Error('Current password is incorrect'), { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        lastPasswordChange: new Date(),
      },
    });

    return res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/me/security — 보안 설정 조회 ───────────────

router.get('/security', authenticate, async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: {
        twoFactorEnabled: true,
        lastPasswordChange: true,
      },
    });

    if (!user) {
      throw Object.assign(new Error('User not found'), { status: 404 });
    }

    return res.json({
      data: {
        twoFactorEnabled: user.twoFactorEnabled,
        lastPasswordChange: user.lastPasswordChange.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/me/security — 보안 설정 수정 ───────────────

router.put('/security', authenticate, validate(updateSecuritySchema), async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;
    const { twoFactorEnabled } = req.body as z.infer<typeof updateSecuritySchema>['body'];

    const user = await prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
    });

    if (!user) {
      throw Object.assign(new Error('User not found'), { status: 404 });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled },
    });

    return res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/me/notifications/settings — 알림 설정 조회 ─

router.get('/notifications/settings', authenticate, async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;

    let settings = await prisma.notificationSetting.findUnique({
      where: { userId },
    });

    if (!settings) {
      settings = await prisma.notificationSetting.create({
        data: {
          userId,
          emailNotifications: true,
          pushNotifications: true,
        },
      });
    }

    return res.json({
      data: {
        emailAlerts: settings.emailNotifications,
        smsAlerts: false,
        pushAlerts: settings.pushNotifications,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/me/notifications/settings — 알림 설정 수정 ─

router.put('/notifications/settings', authenticate, validate(updateNotificationSettingsSchema), async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;
    const { emailAlerts, smsAlerts, pushAlerts } = req.body as z.infer<typeof updateNotificationSettingsSchema>['body'];

    const updateData: Record<string, boolean> = {};
    if (emailAlerts !== undefined) {
      updateData.emailNotifications = emailAlerts;
    }
    if (pushAlerts !== undefined) {
      updateData.pushNotifications = pushAlerts;
    }

    await prisma.notificationSetting.upsert({
      where: { userId },
      update: updateData,
      create: {
        userId,
        emailNotifications: emailAlerts ?? true,
        pushNotifications: pushAlerts ?? true,
      },
    });

    return res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/me/activity-log — 사용자 활동 로그 조회 ────

router.get('/activity-log', authenticate, async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.id;
    const tenantId = req.user!.tenantId;
    const { page, limit, skip, sortBy, sortOrder } = parsePagination(req.query);

    const validSortFields = ['createdAt', 'action', 'resource'];
    const orderField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

    const where = {
      userId,
      tenantId,
    };

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [orderField]: sortOrder },
        select: {
          id: true,
          createdAt: true,
          action: true,
          description: true,
          resource: true,
          resourceId: true,
          ipAddress: true,
        },
      }),
      prisma.activityLog.count({ where }),
    ]);

    const data = logs.map((log) => ({
      id: log.id,
      date: log.createdAt.toISOString(),
      action: log.action,
      detail: log.description ?? `${log.action} ${log.resource}${log.resourceId ? ` (${log.resourceId})` : ''}`,
    }));

    return res.json(paginatedResponse(data, total, page, limit));
  } catch (err) {
    next(err);
  }
});

export default router;
