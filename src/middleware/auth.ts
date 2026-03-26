import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret';

export interface AuthUser {
  id: string;
  tenantId: string;
  role?: string;
}

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
  user?: AuthUser;
}

export function authenticate(req: AuthRequest, _res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    next(Object.assign(new Error('인증이 필요합니다.'), { status: 401 }));
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string; tenantId: string; role?: string };
    req.userId = payload.userId;
    req.userRole = payload.role;
    req.user = {
      id: payload.userId,
      tenantId: payload.tenantId,
      role: payload.role,
    };
    next();
  } catch {
    next(Object.assign(new Error('유효하지 않은 토큰입니다.'), { status: 401 }));
  }
}

export function authorize(...roles: string[]) {
  return (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      next(Object.assign(new Error('권한이 없습니다.'), { status: 403 }));
      return;
    }
    next();
  };
}
