import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = bcrypt.hashSync('password123', 10);

  // ─── Tenants ───────────────────────────────────────────
  const tenant1 = await prisma.tenant.upsert({
    where: { id: 'tenant-001' },
    update: {},
    create: {
      id: 'tenant-001',
      name: '주식회사 미래기술',
      country: 'KR',
      language: 'ko',
      currency: 'KRW',
      timezone: 'Asia/Seoul',
      businessType: 'IT/소프트웨어',
      adminEmail: 'admin@miraetech.co.kr',
      userCount: 5,
      maxUsers: 100,
      subscriptionPlan: 'PROFESSIONAL',
      subscriptionStatus: 'ACTIVE',
      features: ['attendance', 'payroll', 'okr', 'performance', 'ai-anomaly', 'ess', 'reporting'],
      ssoEnabled: true,
      mfaRequired: false,
    },
  });

  const tenant2 = await prisma.tenant.upsert({
    where: { id: 'tenant-002' },
    update: {},
    create: {
      id: 'tenant-002',
      name: '한빛유통 주식회사',
      country: 'KR',
      language: 'ko',
      currency: 'KRW',
      timezone: 'Asia/Seoul',
      businessType: '유통/물류',
      adminEmail: 'admin@hanbit.co.kr',
      userCount: 3,
      maxUsers: 50,
      subscriptionPlan: 'STARTER',
      subscriptionStatus: 'ACTIVE',
      features: ['attendance', 'payroll', 'ess'],
      ssoEnabled: false,
      mfaRequired: false,
    },
  });

  const tenant3 = await prisma.tenant.upsert({
    where: { id: 'tenant-003' },
    update: {},
    create: {
      id: 'tenant-003',
      name: '그린헬스케어',
      country: 'KR',
      language: 'ko',
      currency: 'KRW',
      timezone: 'Asia/Seoul',
      businessType: '헬스케어/의료',
      adminEmail: 'admin@greenhealth.kr',
      userCount: 2,
      maxUsers: 30,
      subscriptionPlan: 'FREE',
      subscriptionStatus: 'TRIAL',
      features: ['attendance', 'ess'],
      ssoEnabled: false,
      mfaRequired: false,
    },
  });

  // ─── Departments ───────────────────────────────────────
  const departments = [
    { id: 'dept-001', tenantId: tenant1.id, name: '개발팀', employeeCount: 3 },
    { id: 'dept-002', tenantId: tenant1.id, name: '인사팀', employeeCount: 1 },
    { id: 'dept-003', tenantId: tenant1.id, name: '마케팅팀', employeeCount: 1 },
    { id: 'dept-004', tenantId: tenant2.id, name: '물류운영팀', employeeCount: 2 },
    { id: 'dept-005', tenantId: tenant2.id, name: '경영지원팀', employeeCount: 1 },
    { id: 'dept-006', tenantId: tenant3.id, name: '진료지원팀', employeeCount: 2 },
  ];

  for (const dept of departments) {
    await prisma.department.upsert({
      where: { tenantId_name: { tenantId: dept.tenantId, name: dept.name } },
      update: {},
      create: dept,
    });
  }

  // ─── Users ─────────────────────────────────────────────
  const user1 = await prisma.user.upsert({
    where: { email: 'admin@miraetech.co.kr' },
    update: {},
    create: {
      id: 'user-001',
      email: 'admin@miraetech.co.kr',
      password: hashedPassword,
      name: '김도현',
      role: 'ADMIN',
      phone: '010-1234-5678',
      department: '개발팀',
      position: 'CTO',
      twoFactorEnabled: true,
      isActive: true,
      tenantId: tenant1.id,
    },
  });

  const user2 = await prisma.user.upsert({
    where: { email: 'park.suji@miraetech.co.kr' },
    update: {},
    create: {
      id: 'user-002',
      email: 'park.suji@miraetech.co.kr',
      password: hashedPassword,
      name: '박수지',
      role: 'USER',
      phone: '010-2345-6789',
      department: '인사팀',
      position: '인사매니저',
      twoFactorEnabled: false,
      isActive: true,
      tenantId: tenant1.id,
    },
  });

  const user3 = await prisma.user.upsert({
    where: { email: 'lee.jh@miraetech.co.kr' },
    update: {},
    create: {
      id: 'user-003',
      email: 'lee.jh@miraetech.co.kr',
      password: hashedPassword,
      name: '이정훈',
      role: 'USER',
      phone: '010-3456-7890',
      department: '개발팀',
      position: '시니어 개발자',
      twoFactorEnabled: false,
      isActive: true,
      tenantId: tenant1.id,
    },
  });

  const user4 = await prisma.user.upsert({
    where: { email: 'choi.yuna@miraetech.co.kr' },
    update: {},
    create: {
      id: 'user-004',
      email: 'choi.yuna@miraetech.co.kr',
      password: hashedPassword,
      name: '최유나',
      role: 'USER',
      phone: '010-4567-8901',
      department: '마케팅팀',
      position: '마케팅 리드',
      twoFactorEnabled: false,
      isActive: true,
      tenantId: tenant1.id,
    },
  });

  const user5 = await prisma.user.upsert({
    where: { email: 'han.ms@miraetech.co.kr' },
    update: {},
    create: {
      id: 'user-005',
      email: 'han.ms@miraetech.co.kr',
      password: hashedPassword,
      name: '한민수',
      role: 'USER',
      phone: '010-5678-9012',
      department: '개발팀',
      position: '주니어 개발자',
      twoFactorEnabled: false,
      isActive: true,
      tenantId: tenant1.id,
    },
  });

  const user6 = await prisma.user.upsert({
    where: { email: 'admin@hanbit.co.kr' },
    update: {},
    create: {
      id: 'user-006',
      email: 'admin@hanbit.co.kr',
      password: hashedPassword,
      name: '정우성',
      role: 'ADMIN',
      phone: '010-6789-0123',
      department: '경영지원팀',
      position: '대표이사',
      twoFactorEnabled: false,
      isActive: true,
      tenantId: tenant2.id,
    },
  });

  const user7 = await prisma.user.upsert({
    where: { email: 'kim.sh@hanbit.co.kr' },
    update: {},
    create: {
      id: 'user-007',
      email: 'kim.sh@hanbit.co.kr',
      password: hashedPassword,
      name: '김서현',
      role: 'USER',
      phone: '010-7890-1234',
      department: '물류운영팀',
      position: '물류매니저',
      twoFactorEnabled: false,
      isActive: true,
      tenantId: tenant2.id,
    },
  });

  const user8 = await prisma.user.upsert({
    where: { email: 'admin@greenhealth.kr' },
    update: {},
    create: {
      id: 'user-008',
      email: 'admin@greenhealth.kr',
      password: hashedPassword,
      name: '오진아',
      role: 'ADMIN',
      phone: '010-8901-2345',
      department: '진료지원팀',
      position: '원장',
      twoFactorEnabled: false,
      isActive: true,
      tenantId: tenant3.id,
    },
  });

  // ─── Employees ─────────────────────────────────────────
  const emp1 = await prisma.employee.upsert({
    where: { employeeNumber: 'MR-2022-001' },
    update: {},
    create: {
      id: 'emp-001',
      employeeNumber: 'MR-2022-001',
      name: '김도현',
      email: 'admin@miraetech.co.kr',
      department: '개발팀',
      position: 'CTO',
      hireDate: new Date('2022-01-15'),
      salary: 9600000,
      employmentType: '정규직',
      status: 'ACTIVE',
      tenantId: tenant1.id,
      userId: user1.id,
    },
  });

  const emp2 = await prisma.employee.upsert({
    where: { employeeNumber: 'MR-2022-002' },
    update: {},
    create: {
      id: 'emp-002',
      employeeNumber: 'MR-2022-002',
      name: '박수지',
      email: 'park.suji@miraetech.co.kr',
      department: '인사팀',
      position: '인사매니저',
      hireDate: new Date('2022-03-02'),
      salary: 5800000,
      employmentType: '정규직',
      status: 'ACTIVE',
      tenantId: tenant1.id,
      userId: user2.id,
    },
  });

  const emp3 = await prisma.employee.upsert({
    where: { employeeNumber: 'MR-2023-003' },
    update: {},
    create: {
      id: 'emp-003',
      employeeNumber: 'MR-2023-003',
      name: '이정훈',
      email: 'lee.jh@miraetech.co.kr',
      department: '개발팀',
      position: '시니어 개발자',
      hireDate: new Date('2023-02-13'),
      salary: 7200000,
      employmentType: '정규직',
      status: 'ACTIVE',
      tenantId: tenant1.id,
      userId: user3.id,
    },
  });

  const emp4 = await prisma.employee.upsert({
    where: { employeeNumber: 'MR-2023-004' },
    update: {},
    create: {
      id: 'emp-004',
      employeeNumber: 'MR-2023-004',
      name: '최유나',
      email: 'choi.yuna@miraetech.co.kr',
      department: '마케팅팀',
      position: '마케팅 리드',
      hireDate: new Date('2023-06-01'),
      salary: 6200000,
      employmentType: '정규직',
      status: 'ACTIVE',
      tenantId: tenant1.id,
      userId: user4.id,
    },
  });

  const emp5 = await prisma.employee.upsert({
    where: { employeeNumber: 'MR-2024-005' },
    update: {},
    create: {
      id: 'emp-005',
      employeeNumber: 'MR-2024-005',
      name: '한민수',
      email: 'han.ms@miraetech.co.kr',
      department: '개발팀',
      position: '주니어 개발자',
      hireDate: new Date('2024-01-08'),
      salary: 4200000,
      employmentType: '정규직',
      status: 'ACTIVE',
      tenantId: tenant1.id,
      userId: user5.id,
    },
  });

  const emp6 = await prisma.employee.upsert({
    where: { employeeNumber: 'HB-2021-001' },
    update: {},
    create: {
      id: 'emp-006',
      employeeNumber: 'HB-2021-001',
      name: '정우성',
      email: 'admin@hanbit.co.kr',
      department: '경영지원팀',
      position: '대표이사',
      hireDate: new Date('2021-05-10'),
      salary: 12000000,
      employmentType: '정규직',
      status: 'ACTIVE',
      tenantId: tenant2.id,
      userId: user6.id,
    },
  });

  const emp7 = await prisma.employee.upsert({
    where: { employeeNumber: 'HB-2022-002' },
    update: {},
    create: {
      id: 'emp-007',
      employeeNumber: 'HB-2022-002',
      name: '김서현',
      email: 'kim.sh@hanbit.co.kr',
      department: '물류운영팀',
      position: '물류매니저',
      hireDate: new Date('2022-08-22'),
      salary: 5400000,
      employmentType: '정규직',
      status: 'ACTIVE',
      tenantId: tenant2.id,
      userId: user7.id,
    },
  });

  const emp8 = await prisma.employee.upsert({
    where: { employeeNumber: 'GH-2023-001' },
    update: {},
    create: {
      id: 'emp-008',
      employeeNumber: 'GH-2023-001',
      name: '오진아',
      email: 'admin@greenhealth.kr',
      department: '진료지원팀',
      position: '원장',
      hireDate: new Date('2023-09-01'),
      salary: 15000000,
      employmentType: '정규직',
      status: 'ACTIVE',
      tenantId: tenant3.id,
      userId: user8.id,
    },
  });

  // ─── Attendance Records ────────────────────────────────
  const attendanceData = [
    { id: 'att-001', date: new Date('2025-01-20'), clockIn: new Date('2025-01-20T08:55:00'), clockOut: new Date('2025-01-20T18:05:00'), status: 'NORMAL' as const, overtimeMinutes: 5, employeeId: emp1.id, tenantId: tenant1.id },
    { id: 'att-002', date: new Date('2025-01-20'), clockIn: new Date('2025-01-20T09:15:00'), clockOut: new Date('2025-01-20T18:00:00'), status: 'LATE' as const, overtimeMinutes: 0, employeeId: emp2.id, tenantId: tenant1.id },
    { id: 'att-003', date: new Date('2025-01-20'), clockIn: new Date('2025-01-20T08:50:00'), clockOut: new Date('2025-01-20T20:30:00'), status: 'NORMAL' as const, overtimeMinutes: 150, employeeId: emp3.id, tenantId: tenant1.id },
    { id: 'att-004', date: new Date('2025-01-20'), clockIn: new Date('2025-01-20T09:00:00'), clockOut: new Date('2025-01-20T15:00:00'), status: 'EARLY_LEAVE' as const, overtimeMinutes: 0, employeeId: emp4.id, tenantId: tenant1.id },
    { id: 'att-005', date: new Date('2025-01-21'), clockIn: new Date('2025-01-21T08:45:00'), clockOut: new Date('2025-01-21T18:00:00'), status: 'NORMAL' as const, overtimeMinutes: 0, employeeId: emp1.id, tenantId: tenant1.id },
    { id: 'att-006', date: new Date('2025-01-21'), clockIn: new Date('2025-01-21T08:58:00'), clockOut: new Date('2025-01-21T18:10:00'), status: 'NORMAL' as const, overtimeMinutes: 10, employeeId: emp5.id, tenantId: tenant1.id },
    { id: 'att-007', date: new Date('2025-01-20'), clockIn: new Date('2025-01-20T08:30:00'), clockOut: new Date('2025-01-20T17:30:00'), status: 'NORMAL' as const, overtimeMinutes: 0, employeeId: emp6.id, tenantId: tenant2.id },
    { id: 'att-008', date: new Date('2025-01-20'), clockIn: null, clockOut: null, status: 'ABSENT' as const, overtimeMinutes: 0, employeeId: emp7.id, tenantId: tenant2.id },
  ];

  for (const att of attendanceData) {
    await prisma.attendanceRecord.upsert({
      where: { id: att.id },
      update: {},
      create: att,
    });
  }

  // ─── Leave Requests ────────────────────────────────────
  const leaveData = [
    { id: 'leave-001', leaveType: '연차', startDate: new Date('2025-02-03'), endDate: new Date('2025-02-04'), days: 2, reason: '개인 사유로 인한 연차 사용', status: 'APPROVED' as const, reviewedBy: 'user-002', reviewedAt: new Date('2025-01-25'), employeeId: emp3.id, tenantId: tenant1.id },
    { id: 'leave-002', leaveType: '병가', startDate: new Date('2025-01-27'), endDate: new Date('2025-01-28'), days: 2, reason: '독감 증상으로 병원 진료 필요', status: 'APPROVED' as const, reviewedBy: 'user-002', reviewedAt: new Date('2025-01-26'), employeeId: emp5.id, tenantId: tenant1.id },
    { id: 'leave-003', leaveType: '연차', startDate: new Date('2025-02-10'), endDate: new Date('2025-02-14'), days: 5, reason: '가족여행', status: 'PENDING' as const, employeeId: emp4.id, tenantId: tenant1.id },
    { id: 'leave-004', leaveType: '반차', startDate: new Date('2025-01-22'), endDate: new Date('2025-01-22'), days: 0.5, reason: '오전 병원 방문', status: 'APPROVED' as const, reviewedBy: 'user-001', reviewedAt: new Date('2025-01-21'), employeeId: emp2.id, tenantId: tenant1.id },
    { id: 'leave-005', leaveType: '경조사', startDate: new Date('2025-02-01'), endDate: new Date('2025-02-03'), days: 3, reason: '결혼식 참석', status: 'REJECTED' as const, reviewedBy: 'user-006', reviewedAt: new Date('2025-01-28'), employeeId: emp7.id, tenantId: tenant2.id },
  ];

  for (const lv of leaveData) {
    await prisma.leaveRequest.upsert({
      where: { id: lv.id },
      update: {},
      create: lv,
    });
  }

  // ─── Payroll Records ───────────────────────────────────
  const payrollData = [
    { id: 'pay-001', month: '2025-01', baseSalary: 9600000, overtimePay: 150000, bonus: 0, mealAllowance: 200000, transportAllowance: 100000, nationalPension: 432000, healthInsurance: 345600, employmentInsurance: 86400, incomeTax: 1050000, localIncomeTax: 105000, totalEarnings: 10050000, totalDeductions: 2019000, netPay: 8031000, status: 'PAID' as const, payDate: new Date('2025-01-25'), employeeId: emp1.id, tenantId: tenant1.id },
    { id: 'pay-002', month: '2025-01', baseSalary: 5800000, overtimePay: 0, bonus: 0, mealAllowance: 200000, transportAllowance: 100000, nationalPension: 261000, healthInsurance: 208800, employmentInsurance: 52200, incomeTax: 450000, localIncomeTax: 45000, totalEarnings: 6100000, totalDeductions: 1017000, netPay: 5083000, status: 'PAID' as const, payDate: new Date('2025-01-25'), employeeId: emp2.id, tenantId: tenant1.id },
    { id: 'pay-003', month: '2025-01', baseSalary: 7200000, overtimePay: 750000, bonus: 0, mealAllowance: 200000, transportAllowance: 100000, nationalPension: 324000, healthInsurance: 259200, employmentInsurance: 64800, incomeTax: 720000, localIncomeTax: 72000, totalEarnings: 8250000, totalDeductions: 1440000, netPay: 6810000, status: 'PAID' as const, payDate: new Date('2025-01-25'), employeeId: emp3.id, tenantId: tenant1.id },
    { id: 'pay-004', month: '2025-01', baseSalary: 6200000, overtimePay: 0, bonus: 500000, mealAllowance: 200000, transportAllowance: 100000, nationalPension: 279000, healthInsurance: 223200, employmentInsurance: 55800, incomeTax: 550000, localIncomeTax: 55000, totalEarnings: 7000000, totalDeductions: 1163000, netPay: 5837000, status: 'PAID' as const, payDate: new Date('2025-01-25'), employeeId: emp4.id, tenantId: tenant1.id },
    { id: 'pay-005', month: '2025-01', baseSalary: 4200000, overtimePay: 50000, bonus: 0, mealAllowance: 200000, transportAllowance: 100000, nationalPension: 189000, healthInsurance: 151200, employmentInsurance: 37800, incomeTax: 250000, localIncomeTax: 25000, totalEarnings: 4550000, totalDeductions: 653000, netPay: 3897000, status: 'PAID' as const, payDate: new Date('2025-01-25'), employeeId: emp5.id, tenantId: tenant1.id },
    { id: 'pay-006', month: '2025-01', baseSalary: 5400000, overtimePay: 0, bonus: 0, mealAllowance: 150000, transportAllowance: 100000, nationalPension: 243000, healthInsurance: 194400, employmentInsurance: 48600, incomeTax: 400000, localIncomeTax: 40000, totalEarnings: 5650000, totalDeductions: 926000, netPay: 4724000, status: 'CONFIRMED' as const, employeeId: emp7.id, tenantId: tenant2.id },
  ];

  for (const pr of payrollData) {
    await prisma.payrollRecord.upsert({
      where: { id: pr.id },
      update: {},
      create: pr,
    });
  }

  // ─── OKRs ─────────────────────────────────────────────
  const okrData = [
    {
      id: 'okr-001',
      quarter: '2025-Q1',
      objectives: [
        { title: 'HRiZen v2.0 출시', keyResults: [{ description: '핵심 기능 5개 개발 완료', target: 5, current: 3 }, { description: '베타 테스트 참여 기업 20개 확보', target: 20, current: 12 }] },
        { title: 'API 성능 최적화', keyResults: [{ description: '평균 응답시간 200ms 이하', target: 200, current: 250 }] },
      ],
      overallProgress: 55,
      status: 'IN_PROGRESS' as const,
      employeeId: emp1.id,
      tenantId: tenant1.id,
    },
    {
      id: 'okr-002',
      quarter: '2025-Q1',
      objectives: [
        { title: '채용 프로세스 개선', keyResults: [{ description: '평균 채용 소요일 30일 이하 달성', target: 30, current: 35 }, { description: '지원자 만족도 4.5점 이상', target: 4.5, current: 4.2 }] },
      ],
      overallProgress: 70,
      status: 'IN_PROGRESS' as const,
      employeeId: emp2.id,
      tenantId: tenant1.id,
    },
    {
      id: 'okr-003',
      quarter: '2025-Q1',
      objectives: [
        { title: '마케팅 리드 생성 확대', keyResults: [{ description: '월간 리드 500건 확보', target: 500, current: 420 }, { description: 'CPA 15,000원 이하', target: 15000, current: 13200 }] },
      ],
      overallProgress: 80,
      status: 'IN_PROGRESS' as const,
      employeeId: emp4.id,
      tenantId: tenant1.id,
    },
    {
      id: 'okr-004',
      quarter: '2024-Q4',
      objectives: [
        { title: '마이크로서비스 아키텍처 전환', keyResults: [{ description: '모듈 3개 전환 완료', target: 3, current: 3 }, { description: '서비스 가용성 99.9% 유지', target: 99.9, current: 99.95 }] },
      ],
      overallProgress: 100,
      status: 'COMPLETED' as const,
      employeeId: emp3.id,
      tenantId: tenant1.id,
    },
  ];

  for (const okr of okrData) {
    await prisma.oKR.upsert({
      where: { id: okr.id },
      update: {},
      create: okr,
    });
  }

  // ─── Performance Reviews ───────────────────────────────
  const reviewData = [
    {
      id: 'review-001',
      reviewPeriod: '2024-H2',
      overallScore: 4.5,
      selfAssessment: { score: 4.3, summary: '하반기 목표 대비 대부분 초과 달성했으며, 팀 리딩에 집중했습니다.' },
      managerReview: { score: 4.5, summary: '기술 리더십이 뛰어나고 팀원 성장에 큰 기여를 했습니다.' },
      goals: [{ title: 'v2.0 아키텍처 설계', status: '완료' }, { title: '주니어 개발자