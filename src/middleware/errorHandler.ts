import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: '입력값이 올바르지 않습니다.',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    });
    return;
  }

  // Prisma known errors
  const prismaCode = (err as any)?.code;
  if (prismaCode === 'P2002') {
    const fields = ((err as any).meta?.target as string[]) ?? [];
    res.status(409).json({ error: `이미 존재하는 데이터입니다: ${fields.join(', ')}` });
    return;
  }
  if (prismaCode === 'P2025') {
    res.status(404).json({ error: '데이터를 찾을 수 없습니다.' });
    return;
  }

  // Custom errors with status
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? 500;
  const message = err instanceof Error ? err.message : '서버 내부 오류가 발생했습니다.';

  if (status >= 500) {
    console.error('[error]', err);
  }

  res.status(status).json({ error: message });
}
