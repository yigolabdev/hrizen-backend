# HRiZen Backend

중소·중견 기업이 복잡한 인사·급여·근태 업무를 하나의 플랫폼에서 손쉽게 처리하도록 지원합니다. 반복 업무를 자동화하고, 데이터 기반 인사 의사결정을 가능케 해 인사 담당자와 임직원의 효율성을 극대화합니다.

## Tech Stack

- Express 5 + TypeScript (strict)
- Prisma ORM + PostgreSQL
- JWT Authentication + Role-based Authorization
- Zod Request Validation
- Helmet + CORS + Rate Limiting
- Docker + Docker Compose

## Getting Started

```bash
cp .env.example .env
# Edit .env with your database URL
npm install
npx prisma migrate dev
npm run seed
npm run dev
```

## Docker

```bash
docker-compose up -d
```

## Build

```bash
npm run build
npm start
```
