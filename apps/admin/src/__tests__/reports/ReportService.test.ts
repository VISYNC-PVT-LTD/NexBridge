import mongoose from 'mongoose';
import { AttendanceDay } from '@models/AttendanceDay';
import { Leave }         from '@models/Leave';
import { PayrollRecord } from '@models/PayrollRecord';
import { User }          from '@models/User';
import { AuditLog }      from '@models/AuditLog';
import { ReportService } from '@services/ReportService';
import { AttendanceSession } from '@models/AttendanceSession';

jest.mock('@lib/db/connect', () => ({ connectDB: jest.fn() }));
const mockAddRow = jest.fn();

jest.mock('exceljs', () => ({
  __esModule: true,
  default: {
    Workbook: jest.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.addWorksheet = jest.fn().mockReturnValue({
        columns: [] as unknown[],
        getRow: jest.fn().mockReturnValue({ font: {} }),
        addRow: mockAddRow,
      });
      this.xlsx = { writeBuffer: jest.fn().mockResolvedValue(Buffer.from('xlsx-data')) };
    }),
  },
}));

const ADMIN_ID = new mongoose.Types.ObjectId().toHexString();
const EMP_OID  = new mongoose.Types.ObjectId();
const EMP_OID2 = new mongoose.Types.ObjectId();

beforeEach(() => {
  jest.clearAllMocks();
  // 24-hour rule: services reconcile overdue sessions first; default = none overdue.
  jest.spyOn(AttendanceSession, 'find').mockReturnValue({ select: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) } as never);
  jest.spyOn(AuditLog, 'create').mockResolvedValue({} as never);
});

// ─── U-REP-01 ────────────────────────────────────────────────────────────────
describe('U-REP-01: attendanceReport', () => {
  it('returns formatted rows with employee name from User lookup', async () => {
    const fakeDay = {
      _id: new mongoose.Types.ObjectId(), employeeId: EMP_OID,
      dateString: '2026-06-01', status: 'present',
      totalMinutes: 480, overtimeMinutes: 30, isLateArrival: false, lateByMinutes: 0,
    };
    jest.spyOn(User, 'find').mockReturnValue({
      lean: () => Promise.resolve([
        { _id: EMP_OID, firstName: 'Alice', lastName: 'Smith', employeeId: 'EMP001', department: 'Eng' },
      ]),
    } as never);
    jest.spyOn(AttendanceDay, 'find').mockReturnValue({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([fakeDay]) }) }) }),
    } as never);
    jest.spyOn(AttendanceDay, 'countDocuments').mockResolvedValue(1 as never);

    const result = await ReportService.attendanceReport(ADMIN_ID, {
      startDate: '2026-06-01', endDate: '2026-06-30', page: 1, limit: 20,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].employeeName).toBe('Alice Smith');
    expect(result.data[0].employeeId).toBe('EMP001');
    expect(result.data[0].status).toBe('present');
    expect(result.meta.total).toBe(1);
  });
});

// ─── U-REP-02 ────────────────────────────────────────────────────────────────
describe('U-REP-02: attendanceReport 90-day limit', () => {
  it('throws AppError REP_001 when range exceeds 90 days', async () => {
    await expect(
      ReportService.attendanceReport(ADMIN_ID, {
        startDate: '2026-01-01', endDate: '2026-06-01', page: 1, limit: 20,
      }),
    ).rejects.toMatchObject({ code: 'REP_001', httpStatus: 400 });
  });
});

// ─── U-REP-03 ────────────────────────────────────────────────────────────────
describe('U-REP-03: attendanceExport 366-day limit', () => {
  it('throws AppError REP_002 when range exceeds 366 days', async () => {
    await expect(
      ReportService.attendanceExport(ADMIN_ID, { startDate: '2024-01-01', endDate: '2025-06-01' }),
    ).rejects.toMatchObject({ code: 'REP_002', httpStatus: 400 });
  });
});

// ─── U-REP-04 ────────────────────────────────────────────────────────────────
describe('U-REP-04: attendanceExport returns Buffer', () => {
  it('returns a Buffer for valid date range', async () => {
    jest.spyOn(User, 'find').mockReturnValue({
      lean: () => Promise.resolve([]),
    } as never);
    jest.spyOn(AttendanceDay, 'find').mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve([]) }),
    } as never);

    const buffer = await ReportService.attendanceExport(ADMIN_ID, {
      startDate: '2026-06-01', endDate: '2026-06-30',
    });
    expect(Buffer.isBuffer(buffer)).toBe(true);
  });
});

// ─── U-REP-05 ────────────────────────────────────────────────────────────────
describe('U-REP-05: leaveReport paginated list', () => {
  it('returns formatted leave rows with employee name', async () => {
    const fakeLeave = {
      _id: new mongoose.Types.ObjectId(), employeeId: EMP_OID,
      leaveType: 'paidLeave', duration: 'full',
      startDate: new Date('2026-06-10'), endDate: new Date('2026-06-12'),
      totalDays: 3, leaveYear: 2026, status: 'approved', reason: 'Vacation',
    };
    jest.spyOn(User, 'find').mockReturnValue({
      lean: () => Promise.resolve([
        { _id: EMP_OID, firstName: 'Bob', lastName: 'Jones', employeeId: 'EMP002', department: 'HR' },
      ]),
    } as never);
    jest.spyOn(Leave, 'find').mockReturnValue({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([fakeLeave]) }) }) }),
    } as never);
    jest.spyOn(Leave, 'countDocuments').mockResolvedValue(1 as never);

    const result = await ReportService.leaveReport(ADMIN_ID, { page: 1, limit: 20 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].employeeName).toBe('Bob Jones');
    expect(result.data[0].totalDays).toBe(3);
  });
});

// ─── U-REP-06 ────────────────────────────────────────────────────────────────
describe('U-REP-06: payrollReport data shaping', () => {
  it('returns payroll rows using employeeSnapshot without DB join', async () => {
    const fakeRecord = {
      _id: new mongoose.Types.ObjectId(), yearMonth: '2026-06', status: 'draft',
      employeeSnapshot: {
        employeeId: 'EMP001', firstName: 'Alice', lastName: 'Smith', department: 'Eng', monthlySalary: 50000,
      },
      grossSalary: 50000, netSalary: 47000,
      effectivePresentDays: 22, effectiveWorkingDays: 26,
      deductionBreakdown: { totalDeductions: 3000 },
    };
    jest.spyOn(PayrollRecord, 'find').mockReturnValue({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([fakeRecord]) }) }) }),
    } as never);
    jest.spyOn(PayrollRecord, 'countDocuments').mockResolvedValue(1 as never);

    const result = await ReportService.payrollReport(ADMIN_ID, { page: 1, limit: 20 });
    expect(result.data[0].status).toBe('draft');
    expect(result.data[0].employeeName).toBe('Alice Smith');
    expect(result.data[0].netSalary).toBe(47000);
  });
});

// ─── U-REP-07 ────────────────────────────────────────────────────────────────
describe('U-REP-07: payrollExport DRAFT label', () => {
  it('returns Buffer for draft records and uses DRAFT status label', async () => {
    const fakeRecord = {
      _id: new mongoose.Types.ObjectId(), yearMonth: '2026-06', status: 'draft',
      employeeSnapshot: { employeeId: 'EMP001', firstName: 'Alice', lastName: 'Smith', department: 'Eng', monthlySalary: 50000 },
      grossSalary: 50000, netSalary: 47000, effectiveWorkingDays: 26, effectivePresentDays: 22,
      halfDays: 0, paidLeaveDays: 2, effectiveLwpDays: 0, absentDays: 2,
      deductionBreakdown: { lwpDeduction: 0, absentDeduction: 3000, manualDeduction: 0, totalDeductions: 3000 },
      manualDeductionRemark: '',
    };
    jest.spyOn(PayrollRecord, 'find').mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve([fakeRecord]) }),
    } as never);

    const buffer = await ReportService.payrollExport(ADMIN_ID, {});
    expect(Buffer.isBuffer(buffer)).toBe(true);

    // Verify addRow was called with DRAFT status label
    expect(mockAddRow).toHaveBeenCalledWith(expect.objectContaining({ status: 'DRAFT' }));
  });
});

// ─── U-REP-08 ────────────────────────────────────────────────────────────────
describe('U-REP-08: employeeSummary aggregation', () => {
  it('returns employee list with attendance counts and leave balances', async () => {
    jest.spyOn(User, 'find').mockReturnValue({
      lean: () => Promise.resolve([
        {
          _id: EMP_OID, firstName: 'Alice', lastName: 'Smith',
          employeeId: 'EMP001', department: 'Eng', designation: 'Dev', isActive: true,
          leaveBalances: {
            paidLeave:   { currentYear: 10, carriedForward: 2 },
            sickLeave:   { currentYear: 5,  carriedForward: 0 },
            casualLeave: { currentYear: 3,  carriedForward: 0 },
          },
        },
      ]),
    } as never);
    jest.spyOn(AttendanceDay, 'aggregate').mockResolvedValue([
      { _id: EMP_OID, present: 20, absent: 2, halfDay: 1, leave: 3, lwp: 0, totalOvertime: 60 },
    ] as never);

    const result = await ReportService.employeeSummary(ADMIN_ID, {});
    expect(result.data).toHaveLength(1);
    expect(result.data[0].attendance.presentDays).toBe(20);
    expect(result.data[0].attendance.totalOvertimeMin).toBe(60);
    expect(result.data[0].leaveBalances.paidLeave.currentYear).toBe(10);
  });
});

// ─── U-REP-09 ────────────────────────────────────────────────────────────────
describe('U-REP-09: departmentSummary grouping', () => {
  it('returns attendance rate per department', async () => {
    jest.spyOn(User, 'find').mockReturnValue({
      lean: () => Promise.resolve([
        { _id: EMP_OID,  department: 'Engineering', isActive: true },
        { _id: EMP_OID2, department: 'Engineering', isActive: true },
      ]),
    } as never);
    jest.spyOn(AttendanceDay, 'find').mockReturnValue({
      lean: () => Promise.resolve([
        { _id: new mongoose.Types.ObjectId(), employeeId: EMP_OID,  status: 'present' },
        { _id: new mongoose.Types.ObjectId(), employeeId: EMP_OID2, status: 'absent' },
      ]),
    } as never);
    jest.spyOn(Leave, 'find').mockReturnValue({
      lean: () => Promise.resolve([]),
    } as never);

    const result = await ReportService.departmentSummary(ADMIN_ID, {});
    expect(result.data).toHaveLength(1);
    expect(result.data[0].department).toBe('Engineering');
    expect(result.data[0].totalEmployees).toBe(2);
    expect(result.data[0].attendanceRate).toBe(50);
  });
});

// ─── U-REP-10 ────────────────────────────────────────────────────────────────
describe('U-REP-10: dashboardSummary counts', () => {
  it('returns employee, attendance, pending approval, and payroll counts', async () => {
    jest.spyOn(User, 'countDocuments')
      .mockResolvedValueOnce(10 as never).mockResolvedValueOnce(8 as never);
    jest.spyOn(AttendanceDay, 'countDocuments')
      .mockResolvedValueOnce(7 as never).mockResolvedValueOnce(1 as never);
    jest.spyOn(PayrollRecord, 'countDocuments')
      .mockResolvedValueOnce(3 as never).mockResolvedValueOnce(7 as never);
    const mockCol = {
      countDocuments: jest.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(2),
    };
    jest.spyOn(mongoose.connection, 'collection').mockReturnValue(mockCol as never);

    const result = await ReportService.dashboardSummary(ADMIN_ID);
    expect(result.employees.total).toBe(10);
    expect(result.employees.active).toBe(8);
    expect(result.todayAttendance.present).toBe(7);
    expect(result.pendingApprovals.leaves).toBe(5);
    expect(result.pendingApprovals.regularizations).toBe(2);
    expect(result.payroll.draft).toBe(3);
  });
});
