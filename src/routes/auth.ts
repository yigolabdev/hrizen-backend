import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-in-production';

// ─── Validation Schemas ──────────────────────────────────

const registerSchema = z.object({
  body: z.object({
    email: z
      .string()
      .email('유효한 이메일 주소를 입력해주세요.')
      .max(255, '이메일은 255자 이하여야 합니다.')
      .transform((v) => v.toLowerCase().trim()),
    password: z
      .string()
      .min(8, '비밀번호는 최소 8자 이상이어야 합니다.')
      .max(128, '비밀번호는 128자 이하여야 합니다.')
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/,
        '비밀번호는 대문자, 소문자, 숫자, 특수문자를 각각 1개 이상 포함해야 합니다.'
      ),
    name: z
      .string()
      .min(1, '이름을 입력해주세요.')
      .max(100, '이름은 100자 이하여야 합니다.')
      .trim(),
    tenantId: z
      .string()
      .min(1, '테넌트 ID를 입력해주세요.'),
    phone: z
      .string()
      .max(20)
      .optional(),
    department: z
      .string()
      .max(100)
      .optional(),
    position: z
      .string()
      .max(100)
      .optional(),
  }),
});

const loginSchema = z.object({
  body: z.object({
    email: z
      .string()
      .email('유효한 이메일 주소를 입력해주세요.')
      .transform((v) => v.toLowerCase().trim()),
    password: z
      .string()
      .min(1, '비밀번호를 입력해주세요.'),
  }),
});

// ─── POST /register ──────────────────────────────────────

router.post(
  '/register',
  validate(registerSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email, password, name, tenantId, phone, department, position } = req.body;

      // 테넌트 존재 여부 및 사용자 수 제한 확인
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId, deletedAt: null },
      });

      if (!tenant) {
        res.status(400).json({
          success: false,
          error: {
            code: 'TENANT_NOT_FOUND',
            message: '존재하지 않는 테넌트입니다.',
          },
        });
        return;
      }

      if (tenant.userCount >= tenant.maxUsers) {
        res.status(403).json({
          success: false,
          error: {
            code: 'MAX_USERS_EXCEEDED',
            message: '테넌트의 최대 사용자 수에 도달했습니다.',
          },
        });
        return;
      }

      // 비밀번호 해시
      const hashedPassword = await bcrypt.hash(password, 12);

      // 사용자 생성 및 테넌트 사용자 수 증가를 트랜잭션으로 처리
      const user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email,
            password: hashedPassword,
            name,
            tenantId,
            phone: phone || null,
            department: department || null,
            position: position || null,
            role: 'USER',
            isActive: true,
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
            isActive: true,
            tenantId: true,
            createdAt: true,
          },
        });

        await tx.tenant.update({
          where: { id: tenantId },
          data: { userCount: { increment: 1 } },
        });

        // 기본 알림 설정 생성
        await tx.notificationSetting.create({
          data: {
            userId: newUser.id,
          },
        });

        return newUser;
      });

      // JWT 토큰 발급
      const accessToken = jwt.sign(
        { userId: user.id, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      // 활동 로그 기록
      await prisma.activityLog.create({
        data: {
          action: 'CREATE',
          resource: 'USER',
          resourceId: user.id,
          description: `새 사용자 등록: ${user.email}`,
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
          userId: user.id,
          tenantId: user.tenantId,
        },
      });

      res.status(201).json({
        success: true,
        data: {
          user,
          token: accessToken,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /login ─────────────────────────────────────────

router.post(
  '/login',
  validate(loginSchema),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;

      // 사용자 조회 (삭제되지 않은 활성 사용자만)
      const user = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          password: true,
          name: true,
          role: true,
          phone: true,
          department: true,
          position: true,
          avatarUrl: true,
          isActive: true,
          twoFactorEnabled: true,
          tenantId: true,
          deletedAt: true,
          createdAt: true,
          tenant: {
            select: {
              id: true,
              name: true,
              subscriptionPlan: true,
              subscriptionStatus: true,
            },
          },
        },
      });

      // 사용자가 존재하지 않거나 삭제된 경우
      if (!user || user.deletedAt !== null) {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_CREDENTIALS',
            message: '이메일 또는 비밀번호가 올바르지 않습니다.',
          },
        });
        return;
      }

      // 비활성화된 계정 확인
      if (!user.isActive) {
        res.status(401).json({
          success: false,
          error: {
            code: 'ACCOUNT_DISABLED',
            message: '비활성화된 계정입니다. 관리자에게 문의하세요.',
          },
        });
        return;
      }

      // 비밀번호 검증
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_CREDENTIALS',
            message: '이메일 또는 비밀번호가 올바르지 않습니다.',
          },
        });
        return;
      }

      // JWT 토큰 발급
      const accessToken = jwt.sign(
        { userId: user.id, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      // 활동 로그 기록
      await prisma.activityLog.create({
        data: {
          action: 'LOGIN',
          resource: 'AUTH',
          resourceId: user.id,
          description: `사용자 로그인: ${user.email}`,
          ipAddress: req.ip || null,
          userAgent: req.headers['user-agent'] || null,
          userId: user.id,
          tenantId: user.tenantId,
        },
      });

      // 비밀번호 필드를 제외한 사용자 정보 반환
      const { password: _password, deletedAt: _deletedAt, ...userWithoutPassword } = user;

      res.status(200).json({
        success: true,
        data: {
          user: userWithoutPassword,
          token: accessToken,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /me ─────────────────────────────────────────────

router.get(
  '/me',
  authenticate,
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;

      const user = await prisma.user.findUnique({
        where: { id: userId, deletedAt: null },
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
          tenantId: true,
          createdAt: true,
          updatedAt: true,
          tenant: {
            select: {
              id: true,
              name: true,
              country: true,
              language: true,
              currency: true,
              timezone: true,
              businessType: true,
              subscriptionPlan: true,
              subscriptionStatus: true,
              features: true,
              ssoEnabled: true,
              mfaRequired: true,
            },
          },
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
          notificationSettings: {
            select: {
              emailNotifications: true,
              pushNotifications: true,
              leaveApproval: true,
              payrollReady: true,
              performanceReview: true,
              anomalyAlert: true,
              systemAnnouncement: true,
            },
          },
        },
      });

      if (!user) {
        res.status(404).json({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: '사용자를 찾을 수 없습니다.',
          },
        });
        return;
      }

      if (!user.isActive) {
        res.status(403).json({
          success: false,
          error: {
            code: 'ACCOUNT_DISABLED',
            message: '비활성화된 계정입니다.',
          },
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: user,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
