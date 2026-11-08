import mongoose from 'mongoose';
import { connectDB } from '@lib/db/connect';
import { AttendanceDay } from '@models/AttendanceDay';
import { Leave } from '@models/Leave';
import { PayrollRecord } from '@models/PayrollRecord';
import { User } from '@models/User';
import { AuditLog } from '@models/AuditLog';
import { AppError } from '@services/AuthService';
import { Regularization } from '@models/Regularization';
import { reconcileMissedCheckouts } from '@services/AttendanceService';
import type {
  AttendanceReportQuery,
  AttendanceExportQuery,
  LeaveReportQuery,
  LeaveExportQuery,
  PayrollReportQuery,
  PayrollExportQuery,
  EmployeeSummaryQuery,
  DepartmentSummaryQuery,
  RegularizationReportQuery,
  RegularizationExportQuery,
} from '@validators/report';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysBetween(start: string, end: string): number {
  return (
    Math.ceil((new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60 * 60 * 24)) + 1
  );
}

async function resolveEmployeeIds(filter: {
  employeeId?: string;
  department?: string;
}): Promise<mongoose.Types.ObjectId[] | null> {
  if (!filter.employeeId && !filter.department) return null;

  const userFilter: Record<string, unknown> = {};
  if (filter.employeeId) userFilter._id = new mongoose.Types.ObjectId(filter.employeeId);
  if (filter.department) userFilter.department = filter.department;

  const users = (await User.find(userFilter, '_id').lean()) as { _id: mongoose.Types.ObjectId }[];
  return users.map((u) => u._id);
}

async function writeAuditLog(
  userId: string,
  action: 'REPORT_VIEWED' | 'REPORT_EXPORTED',
  reportType: string,
  filters: Record<string, unknown>,
): Promise<void> {
  await AuditLog.create({
    performedBy: new mongoose.Types.ObjectId(userId),
    action,
    targetType: 'Report',
    changes: { reportType, filters },
  });
}

// ─── Shared lean types ────────────────────────────────────────────────────────

type LeanUser = {
  _id: mongoose.Types.ObjectId;
  firstName: string;
  lastName: string;
  employeeId: string;
  department?: string;
};

type LeanAttDay = {
  _id: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  dateString: string;
  status: string;
  totalMinutes: number;
  overtimeMinutes: number;
  isLateArrival: boolean;
  lateByMinutes: number;
};

type LeanLeave = {
  _id: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  leaveType: string;
  duration: string;
  startDate: Date;
  endDate: Date;
  totalDays: number;
  leaveYear: number;
  status: string;
  reason: string;
};

type LeanPayrollRecord = {
  _id: mongoose.Types.ObjectId;
  yearMonth: string;
  status: string;
  employeeSnapshot: {
    employeeId: string;
    firstName: string;
    lastName: string;
    department?: string;
    designation?: string;
    monthlySalary: number;
  };
  grossSalary: number;
  netSalary: number;
  effectivePresentDays: number;
  effectiveWorkingDays: number;
  halfDays: number;
  paidLeaveDays: number;
  effectiveLwpDays: number;
  absentDays: number;
  deductionBreakdown: {
    lwpDeduction: number;
    absentDeduction: number;
    manualDeduction: number;
    totalDeductions: number;
  };
  manualDeductionRemark: string;
};

async function batchFetchUsers(
  employeeIds: mongoose.Types.ObjectId[],
): Promise<Map<string, LeanUser>> {
  const unique = [...new Set(employeeIds.map((id) => id.toHexString()))];
  const users = (await User.find(
    { _id: { $in: unique.map((id) => new mongoose.Types.ObjectId(id)) } },
    'firstName lastName employeeId department',
  ).lean()) as LeanUser[];
  return new Map(users.map((u) => [u._id.toHexString(), u]));
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ReportService {
  // ── Attendance list ──────────────────────────────────────────────────────────

  static async attendanceReport(userId: string, query: AttendanceReportQuery) {
    await connectDB();
    await reconcileMissedCheckouts(); // 24-hour rule before reporting (docs/85)

    if (daysBetween(query.startDate, query.endDate) > 90) {
      throw new AppError('REP_001', 400, 'Date range exceeds 90-day limit for paginated view.');
    }

    const empIds = await resolveEmployeeIds({
      employeeId: query.employeeId,
      department: query.department,
    });

    const filter: Record<string, unknown> = {
      dateString: { $gte: query.startDate, $lte: query.endDate },
    };
    if (empIds) filter.employeeId = { $in: empIds };
    if (query.status) filter.status = query.status;

    const skip = (query.page - 1) * query.limit;
    const [docs, total] = await Promise.all([
      AttendanceDay.find(filter)
        .sort({ dateString: 1, employeeId: 1 })
        .skip(skip)
        .limit(query.limit)
        .lean() as Promise<LeanAttDay[]>,
      AttendanceDay.countDocuments(filter),
    ]);

    const userMap = await batchFetchUsers(docs.map((d) => d.employeeId));

    const data = docs.map((d) => {
      const u = userMap.get(d.employeeId.toHexString());
      return {
        id:              d._id.toHexString(),
        employeeId:      u?.employeeId ?? d.employeeId.toHexString(),
        employeeName:    u ? `${u.firstName} ${u.lastName}` : 'Unknown',
        department:      u?.department ?? null,
        date:            d.dateString,
        status:          d.status,
        totalMinutes:    d.totalMinutes,
        overtimeMinutes: d.overtimeMinutes,
        isLateArrival:   d.isLateArrival,
        lateByMinutes:   d.lateByMinutes,
      };
    });

    void writeAuditLog(userId, 'REPORT_VIEWED', 'attendance', query as Record<string, unknown>);
    return {
      data,
      meta: {
        page:       query.page,
        limit:      query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // ── Attendance export ─────────────────────────────────────────────────────────

  static async attendanceExport(userId: string, query: AttendanceExportQuery): Promise<Buffer> {
    await connectDB();
    await reconcileMissedCheckouts(); // 24-hour rule before reporting (docs/85)

    if (daysBetween(query.startDate, query.endDate) > 366) {
      throw new AppError('REP_002', 400, 'Date range exceeds 366-day limit for export.');
    }

    const empIds = await resolveEmployeeIds({
      employeeId: query.employeeId,
      department: query.department,
    });

    const filter: Record<string, unknown> = {
      dateString: { $gte: query.startDate, $lte: query.endDate },
    };
    if (empIds) filter.employeeId = { $in: empIds };
    if (query.status) filter.status = query.status;

    const docs = (await AttendanceDay.find(filter)
      .sort({ dateString: 1, employeeId: 1 })
      .lean()) as LeanAttDay[];

    const userMap = await batchFetchUsers(docs.map((d) => d.employeeId));

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Attendance Report');
    ws.columns = [
      { header: 'Employee ID',     key: 'employeeId',      width: 14 },
      { header: 'Employee Name',   key: 'employeeName',    width: 22 },
      { header: 'Department',      key: 'department',      width: 18 },
      { header: 'Date',            key: 'date',            width: 13 },
      { header: 'Status',          key: 'status',          width: 14 },
      { header: 'Total Minutes',   key: 'totalMinutes',    width: 15 },
      { header: 'Overtime Minutes',key: 'overtimeMinutes', width: 17 },
      { header: 'Late Arrival',    key: 'isLateArrival',   width: 13 },
      { header: 'Late By (min)',   key: 'lateByMinutes',   width: 13 },
    ];
    ws.getRow(1).font = { bold: true };

    for (const d of docs) {
      const u = userMap.get(d.employeeId.toHexString());
      ws.addRow({
        employeeId:      u?.employeeId ?? d.employeeId.toHexString(),
        employeeName:    u ? `${u.firstName} ${u.lastName}` : 'Unknown',
        department:      u?.department ?? '',
        date:            d.dateString,
        status:          d.status,
        totalMinutes:    d.totalMinutes,
        overtimeMinutes: d.overtimeMinutes,
        isLateArrival:   d.isLateArrival ? 'Yes' : 'No',
        lateByMinutes:   d.lateByMinutes,
      });
    }

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    void writeAuditLog(userId, 'REPORT_EXPORTED', 'attendance', query as Record<string, unknown>);
    return buffer;
  }

  // ── Leave list ────────────────────────────────────────────────────────────────

  static async leaveReport(userId: string, query: LeaveReportQuery) {
    await connectDB();

    const empIds = await resolveEmployeeIds({
      employeeId: query.employeeId,
      department: query.department,
    });

    const filter: Record<string, unknown> = {};
    if (empIds)          filter.employeeId = { $in: empIds };
    if (query.leaveType) filter.leaveType  = query.leaveType;
    if (query.status)    filter.status     = query.status;
    if (query.leaveYear) filter.leaveYear  = query.leaveYear;
    if (query.startDate) filter.startDate  = { $gte: new Date(query.startDate) };
    if (query.endDate)   filter.endDate    = { $lte: new Date(query.endDate) };

    const skip = (query.page - 1) * query.limit;
    const [docs, total] = await Promise.all([
      Leave.find(filter)
        .sort({ startDate: -1 })
        .skip(skip)
        .limit(query.limit)
        .lean() as Promise<LeanLeave[]>,
      Leave.countDocuments(filter),
    ]);

    const userMap = await batchFetchUsers(docs.map((d) => d.employeeId));

    const data = docs.map((d) => {
      const u = userMap.get(d.employeeId.toHexString());
      return {
        id:           d._id.toHexString(),
        employeeId:   u?.employeeId ?? d.employeeId.toHexString(),
        employeeName: u ? `${u.firstName} ${u.lastName}` : 'Unknown',
        department:   u?.department ?? null,
        leaveType:    d.leaveType,
        duration:     d.duration,
        startDate:    d.startDate.toISOString().slice(0, 10),
        endDate:      d.endDate.toISOString().slice(0, 10),
        totalDays:    d.totalDays,
        leaveYear:    d.leaveYear,
        status:       d.status,
        reason:       d.reason,
      };
    });

    void writeAuditLog(userId, 'REPORT_VIEWED', 'leave', query as Record<string, unknown>);
    return {
      data,
      meta: {
        page:       query.page,
        limit:      query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // ── Leave export ──────────────────────────────────────────────────────────────

  static async leaveExport(userId: string, query: LeaveExportQuery): Promise<Buffer> {
    await connectDB();

    const empIds = await resolveEmployeeIds({
      employeeId: query.employeeId,
      department: query.department,
    });

    const filter: Record<string, unknown> = {};
    if (empIds)          filter.employeeId = { $in: empIds };
    if (query.leaveType) filter.leaveType  = query.leaveType;
    if (query.status)    filter.status     = query.status;
    if (query.leaveYear) filter.leaveYear  = query.leaveYear;
    if (query.startDate) filter.startDate  = { $gte: new Date(query.startDate) };
    if (query.endDate)   filter.endDate    = { $lte: new Date(query.endDate) };

    const docs = (await Leave.find(filter).sort({ startDate: -1 }).lean()) as LeanLeave[];

    const userMap = await batchFetchUsers(docs.map((d) => d.employeeId));

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Leave Report');
    ws.columns = [
      { header: 'Employee ID',   key: 'employeeId',   width: 14 },
      { header: 'Employee Name', key: 'employeeName', width: 22 },
      { header: 'Department',    key: 'department',   width: 18 },
      { header: 'Leave Type',    key: 'leaveType',    width: 14 },
      { header: 'Duration',      key: 'duration',     width: 10 },
      { header: 'Start Date',    key: 'startDate',    width: 13 },
      { header: 'End Date',      key: 'endDate',      width: 13 },
      { header: 'Total Days',    key: 'totalDays',    width: 11 },
      { header: 'Leave Year',    key: 'leaveYear',    width: 11 },
      { header: 'Status',        key: 'status',       width: 12 },
      { header: 'Reason',        key: 'reason',       width: 30 },
    ];
    ws.getRow(1).font = { bold: true };

    for (const d of docs) {
      const u = userMap.get(d.employeeId.toHexString());
      ws.addRow({
        employeeId:   u?.employeeId ?? d.employeeId.toHexString(),
        employeeName: u ? `${u.firstName} ${u.lastName}` : 'Unknown',
        department:   u?.department ?? '',
        leaveType:    d.leaveType,
        duration:     d.duration,
        startDate:    d.startDate.toISOString().slice(0, 10),
        endDate:      d.endDate.toISOString().slice(0, 10),
        totalDays:    d.totalDays,
        leaveYear:    d.leaveYear,
        status:       d.status,
        reason:       d.reason,
      });
    }

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    void writeAuditLog(userId, 'REPORT_EXPORTED', 'leave', query as Record<string, unknown>);
    return buffer;
  }

  // ── Payroll list ──────────────────────────────────────────────────────────────

  static async payrollReport(userId: string, query: PayrollReportQuery) {
    await connectDB();

    const filter: Record<string, unknown> = {};
    if (query.yearMonth)  filter.yearMonth                     = query.yearMonth;
    if (query.status)     filter.status                        = query.status;
    if (query.department) filter['employeeSnapshot.department'] = query.department;

    const skip = (query.page - 1) * query.limit;
    const [docs, total] = await Promise.all([
      PayrollRecord.find(filter)
        .sort({ yearMonth: -1, 'employeeSnapshot.lastName': 1 })
        .skip(skip)
        .limit(query.limit)
        .lean() as unknown as Promise<LeanPayrollRecord[]>,
      PayrollRecord.countDocuments(filter),
    ]);

    const data = docs.map((d) => ({
      id:                   d._id.toHexString(),
      yearMonth:            d.yearMonth,
      status:               d.status,
      employeeId:           d.employeeSnapshot.employeeId,
      employeeName:         `${d.employeeSnapshot.firstName} ${d.employeeSnapshot.lastName}`,
      department:           d.employeeSnapshot.department ?? null,
      designation:          d.employeeSnapshot.designation ?? null,
      grossSalary:          d.grossSalary,
      totalDeductions:      d.deductionBreakdown.totalDeductions,
      netSalary:            d.netSalary,
      effectivePresentDays: d.effectivePresentDays,
      effectiveWorkingDays: d.effectiveWorkingDays,
    }));

    void writeAuditLog(userId, 'REPORT_VIEWED', 'payroll', query as Record<string, unknown>);
    return {
      data,
      meta: {
        page:       query.page,
        limit:      query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  // ── Payroll export ────────────────────────────────────────────────────────────

  static async payrollExport(userId: string, query: PayrollExportQuery): Promise<Buffer> {
    await connectDB();

    const filter: Record<string, unknown> = {};
    if (query.yearMonth)  filter.yearMonth                     = query.yearMonth;
    if (query.status)     filter.status                        = query.status;
    if (query.department) filter['employeeSnapshot.department'] = query.department;

    const docs = (await PayrollRecord.find(filter)
      .sort({ yearMonth: -1, 'employeeSnapshot.lastName': 1 })
      .lean()) as unknown as LeanPayrollRecord[];

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Payroll Report');
    ws.columns = [
      { header: 'Month',            key: 'yearMonth',        width: 10 },
      { header: 'Status',           key: 'status',           width: 11 },
      { header: 'Employee ID',      key: 'employeeId',       width: 14 },
      { header: 'Employee Name',    key: 'employeeName',     width: 22 },
      { header: 'Department',       key: 'department',       width: 18 },
      { header: 'Working Days',     key: 'workingDays',      width: 13 },
      { header: 'Present Days',     key: 'presentDays',      width: 13 },
      { header: 'Half Days',        key: 'halfDays',         width: 10 },
      { header: 'Paid Leave Days',  key: 'paidLeaveDays',    width: 15 },
      { header: 'LWP Days',         key: 'lwpDays',          width: 10 },
      { header: 'Absent Days',      key: 'absentDays',       width: 11 },
      { header: 'Gross Salary',     key: 'grossSalary',      width: 13 },
      { header: 'Total Deductions', key: 'totalDeductions',  width: 17 },
      { header: 'Net Salary',       key: 'netSalary',        width: 13 },
      { header: 'Deduction Remark', key: 'deductionRemark',  width: 20 },
    ];
    ws.getRow(1).font = { bold: true };

    for (const d of docs) {
      ws.addRow({
        yearMonth:       d.yearMonth,
        status:          d.status === 'draft' ? 'DRAFT' : 'Finalised',
        employeeId:      d.employeeSnapshot.employeeId,
        employeeName:    `${d.employeeSnapshot.firstName} ${d.employeeSnapshot.lastName}`,
        department:      d.employeeSnapshot.department ?? '',
        workingDays:     d.effectiveWorkingDays,
        presentDays:     d.effectivePresentDays,
        halfDays:        d.halfDays,
        paidLeaveDays:   d.paidLeaveDays,
        lwpDays:         d.effectiveLwpDays,
        absentDays:      d.absentDays,
        grossSalary:     d.grossSalary,
        totalDeductions: d.deductionBreakdown.totalDeductions,
        netSalary:       d.netSalary,
        deductionRemark: d.manualDeductionRemark ?? '',
      });
    }

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    void writeAuditLog(userId, 'REPORT_EXPORTED', 'payroll', query as Record<string, unknown>);
    return buffer;
  }

  // ── Employee summary ──────────────────────────────────────────────────────────

  static async employeeSummary(userId: string, query: EmployeeSummaryQuery) {
    await connectDB();
    await reconcileMissedCheckouts(); // 24-hour rule before reporting (docs/85)

    const userFilter: Record<string, unknown> = { role: 'employee' };
    if (query.employeeId) userFilter._id        = new mongoose.Types.ObjectId(query.employeeId);
    if (query.department) userFilter.department = query.department;

    type FullUser = {
      _id: mongoose.Types.ObjectId;
      firstName: string;
      lastName: string;
      employeeId: string;
      department?: string;
      designation?: string;
      isActive: boolean;
      leaveBalances: {
        paidLeave:   { currentYear: number; carriedForward: number };
        sickLeave:   { currentYear: number; carriedForward: number };
        casualLeave: { currentYear: number; carriedForward: number };
      };
    };

    const users = (await User.find(
      userFilter,
      'firstName lastName employeeId department designation leaveBalances isActive',
    ).lean()) as FullUser[];

    const userIds = users.map((u) => u._id);

    const attFilter: Record<string, unknown> = { employeeId: { $in: userIds } };
    if (query.year)  attFilter.year  = query.year;
    if (query.month) attFilter.month = query.month;

    type AttAgg = {
      _id: mongoose.Types.ObjectId;
      present: number;
      absent: number;
      halfDay: number;
      leave: number;
      lwp: number;
      totalOvertime: number;
    };

    const attAgg = await AttendanceDay.aggregate<AttAgg>([
      { $match: attFilter },
      {
        $group: {
          _id:           '$employeeId',
          present:       { $sum: { $cond: [{ $eq: ['$status', 'present'] },   1, 0] } },
          absent:        { $sum: { $cond: [{ $eq: ['$status', 'absent'] },    1, 0] } },
          halfDay:       { $sum: { $cond: [{ $eq: ['$status', 'half-day'] },  1, 0] } },
          leave:         { $sum: { $cond: [{ $eq: ['$status', 'leave'] },     1, 0] } },
          lwp:           { $sum: { $cond: [{ $eq: ['$status', 'lwp'] },       1, 0] } },
          totalOvertime: { $sum: '$overtimeMinutes' },
        },
      },
    ]);
    const attMap = new Map(attAgg.map((a) => [a._id.toHexString(), a]));

    const data = users.map((u) => {
      const att = attMap.get(u._id.toHexString());
      return {
        employeeId:   u.employeeId,
        employeeName: `${u.firstName} ${u.lastName}`,
        department:   u.department ?? null,
        designation:  u.designation ?? null,
        isActive:     u.isActive,
        attendance: {
          presentDays:      att?.present      ?? 0,
          absentDays:       att?.absent       ?? 0,
          halfDays:         att?.halfDay      ?? 0,
          leaveDays:        att?.leave        ?? 0,
          lwpDays:          att?.lwp          ?? 0,
          totalOvertimeMin: att?.totalOvertime ?? 0,
        },
        leaveBalances: {
          paidLeave:   {
            currentYear:    u.leaveBalances.paidLeave.currentYear,
            carriedForward: u.leaveBalances.paidLeave.carriedForward,
          },
          sickLeave:   {
            currentYear:    u.leaveBalances.sickLeave.currentYear,
            carriedForward: u.leaveBalances.sickLeave.carriedForward,
          },
          casualLeave: {
            currentYear:    u.leaveBalances.casualLeave.currentYear,
            carriedForward: u.leaveBalances.casualLeave.carriedForward,
          },
        },
      };
    });

    void writeAuditLog(userId, 'REPORT_VIEWED', 'employee-summary', query as Record<string, unknown>);
    return { data };
  }

  // ── Department summary ────────────────────────────────────────────────────────

  static async departmentSummary(userId: string, query: DepartmentSummaryQuery) {
    await connectDB();
    await reconcileMissedCheckouts(); // 24-hour rule before reporting (docs/85)

    type DeptUser = { _id: mongoose.Types.ObjectId; department?: string; isActive: boolean };
    const users = (await User.find({ role: 'employee' }, 'department isActive').lean()) as DeptUser[];
    const userIds = users.map((u) => u._id);

    const attFilter: Record<string, unknown> = { employeeId: { $in: userIds } };
    if (query.year)  attFilter.year  = query.year;
    if (query.month) attFilter.month = query.month;

    type AttDoc = { _id: mongoose.Types.ObjectId; employeeId: mongoose.Types.ObjectId; status: string };
    const attDocs = (await AttendanceDay.find(attFilter, 'employeeId status').lean()) as AttDoc[];

    const leaveFilter: Record<string, unknown> = { employeeId: { $in: userIds }, status: 'approved' };
    if (query.year) leaveFilter.leaveYear = query.year;

    type LeaveDoc = { _id: mongoose.Types.ObjectId; employeeId: mongoose.Types.ObjectId; totalDays: number };
    const leaveDocs = (await Leave.find(leaveFilter, 'employeeId totalDays').lean()) as LeaveDoc[];

    const userDeptMap   = new Map(users.map((u) => [u._id.toHexString(), u.department ?? 'Unassigned']));
    const userActiveMap = new Map(users.map((u) => [u._id.toHexString(), u.isActive]));

    type Bucket = { total: number; active: number; presentDays: number; totalDays: number; leaveDays: number };
    const deptMap = new Map<string, Bucket>();

    for (const u of users) {
      const dept = userDeptMap.get(u._id.toHexString()) ?? 'Unassigned';
      if (!deptMap.has(dept)) deptMap.set(dept, { total: 0, active: 0, presentDays: 0, totalDays: 0, leaveDays: 0 });
      const b = deptMap.get(dept)!;
      b.total += 1;
      if (userActiveMap.get(u._id.toHexString())) b.active += 1;
    }

    for (const a of attDocs) {
      const dept = userDeptMap.get(a.employeeId.toHexString()) ?? 'Unassigned';
      const b = deptMap.get(dept);
      if (!b) continue;
      b.totalDays += 1;
      if (a.status === 'present' || a.status === 'half-day') b.presentDays += 1;
    }

    for (const l of leaveDocs) {
      const dept = userDeptMap.get(l.employeeId.toHexString()) ?? 'Unassigned';
      const b = deptMap.get(dept);
      if (b) b.leaveDays += l.totalDays;
    }

    const data = Array.from(deptMap.entries())
      .map(([department, s]) => ({
        department,
        totalEmployees:       s.total,
        activeEmployees:      s.active,
        attendanceRate:       s.totalDays > 0
          ? Math.round((s.presentDays / s.totalDays) * 100 * 100) / 100
          : null,
        totalLeaveDaysTaken:  s.leaveDays,
      }))
      .sort((a, b) => a.department.localeCompare(b.department));

    void writeAuditLog(userId, 'REPORT_VIEWED', 'department-summary', query as Record<string, unknown>);
    return { data };
  }

  // ── Employee summary export ───────────────────────────────────────────────────

  static async employeeSummaryExport(userId: string, query: EmployeeSummaryQuery): Promise<Buffer> {
    await connectDB();
    await reconcileMissedCheckouts(); // 24-hour rule before reporting (docs/85)

    const userFilter: Record<string, unknown> = { role: 'employee' };
    if (query.employeeId) userFilter._id        = new mongoose.Types.ObjectId(query.employeeId);
    if (query.department) userFilter.department = query.department;

    type FullUser = {
      _id: mongoose.Types.ObjectId;
      firstName: string;
      lastName: string;
      employeeId: string;
      department?: string;
      designation?: string;
      isActive: boolean;
      leaveBalances: {
        paidLeave:   { currentYear: number; carriedForward: number };
        sickLeave:   { currentYear: number; carriedForward: number };
        casualLeave: { currentYear: number; carriedForward: number };
      };
    };

    const users = (await User.find(
      userFilter,
      'firstName lastName employeeId department designation leaveBalances isActive',
    ).lean()) as FullUser[];

    const userIds = users.map((u) => u._id);

    const attFilter: Record<string, unknown> = { employeeId: { $in: userIds } };
    if (query.year)  attFilter.year  = query.year;
    if (query.month) attFilter.month = query.month;

    type AttAgg = { _id: mongoose.Types.ObjectId; present: number; absent: number; halfDay: number; leave: number; lwp: number };
    const attAgg = await AttendanceDay.aggregate<AttAgg>([
      { $match: attFilter },
      { $group: {
        _id:     '$employeeId',
        present: { $sum: { $cond: [{ $eq: ['$status', 'present'] },  1, 0] } },
        absent:  { $sum: { $cond: [{ $eq: ['$status', 'absent'] },   1, 0] } },
        halfDay: { $sum: { $cond: [{ $eq: ['$status', 'half-day'] }, 1, 0] } },
        leave:   { $sum: { $cond: [{ $eq: ['$status', 'leave'] },    1, 0] } },
        lwp:     { $sum: { $cond: [{ $eq: ['$status', 'lwp'] },      1, 0] } },
      }},
    ]);
    const attMap = new Map(attAgg.map((a) => [a._id.toHexString(), a]));

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employee Summary');
    ws.columns = [
      { header: 'Employee ID',  key: 'employeeId',   width: 14 },
      { header: 'Name',         key: 'employeeName', width: 22 },
      { header: 'Department',   key: 'department',   width: 18 },
      { header: 'Designation',  key: 'designation',  width: 18 },
      { header: 'Status',       key: 'status',       width: 10 },
      { header: 'Present',      key: 'presentDays',  width: 10 },
      { header: 'Absent',       key: 'absentDays',   width: 10 },
      { header: 'Half-Day',     key: 'halfDays',     width: 10 },
      { header: 'Leave',        key: 'leaveDays',    width: 10 },
      { header: 'LWP',          key: 'lwpDays',      width: 8  },
      { header: 'PL Balance',   key: 'plBalance',    width: 12 },
      { header: 'SL Balance',   key: 'slBalance',    width: 12 },
      { header: 'CL Balance',   key: 'clBalance',    width: 12 },
    ];
    ws.getRow(1).font = { bold: true };

    for (const u of users) {
      const att = attMap.get(u._id.toHexString());
      ws.addRow({
        employeeId:   u.employeeId,
        employeeName: `${u.firstName} ${u.lastName}`,
        department:   u.department   ?? '',
        designation:  u.designation  ?? '',
        status:       u.isActive ? 'Active' : 'Inactive',
        presentDays:  att?.present  ?? 0,
        absentDays:   att?.absent   ?? 0,
        halfDays:     att?.halfDay  ?? 0,
        leaveDays:    att?.leave    ?? 0,
        lwpDays:      att?.lwp      ?? 0,
        plBalance:    u.leaveBalances.paidLeave.currentYear   + u.leaveBalances.paidLeave.carriedForward,
        slBalance:    u.leaveBalances.sickLeave.currentYear   + u.leaveBalances.sickLeave.carriedForward,
        clBalance:    u.leaveBalances.casualLeave.currentYear + u.leaveBalances.casualLeave.carriedForward,
      });
    }

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    void writeAuditLog(userId, 'REPORT_EXPORTED', 'employee-summary', query as Record<string, unknown>);
    return buffer;
  }

  // ── Department summary export ─────────────────────────────────────────────────

  static async departmentSummaryExport(userId: string, query: DepartmentSummaryQuery): Promise<Buffer> {
    await connectDB();
    await reconcileMissedCheckouts(); // 24-hour rule before reporting (docs/85)

    type DeptUser = { _id: mongoose.Types.ObjectId; department?: string; isActive: boolean };
    const users = (await User.find({ role: 'employee' }, 'department isActive').lean()) as DeptUser[];
    const userIds = users.map((u) => u._id);

    const attFilter: Record<string, unknown> = { employeeId: { $in: userIds } };
    if (query.year)  attFilter.year  = query.year;
    if (query.month) attFilter.month = query.month;

    type AttDoc = { _id: mongoose.Types.ObjectId; employeeId: mongoose.Types.ObjectId; status: string };
    const attDocs = (await AttendanceDay.find(attFilter, 'employeeId status').lean()) as AttDoc[];

    const leaveFilter: Record<string, unknown> = { employeeId: { $in: userIds }, status: 'approved' };
    if (query.year) leaveFilter.leaveYear = query.year;

    type LeaveDoc = { _id: mongoose.Types.ObjectId; employeeId: mongoose.Types.ObjectId; totalDays: number };
    const leaveDocs = (await Leave.find(leaveFilter, 'employeeId totalDays').lean()) as LeaveDoc[];

    const userDeptMap   = new Map(users.map((u) => [u._id.toHexString(), u.department ?? 'Unassigned']));
    const userActiveMap = new Map(users.map((u) => [u._id.toHexString(), u.isActive]));

    type Bucket = { total: number; active: number; presentDays: number; totalDays: number; leaveDays: number };
    const deptMap = new Map<string, Bucket>();

    for (const u of users) {
      const dept = userDeptMap.get(u._id.toHexString()) ?? 'Unassigned';
      if (!deptMap.has(dept)) deptMap.set(dept, { total: 0, active: 0, presentDays: 0, totalDays: 0, leaveDays: 0 });
      const b = deptMap.get(dept)!;
      b.total += 1;
      if (userActiveMap.get(u._id.toHexString())) b.active += 1;
    }

    for (const a of attDocs) {
      const dept = userDeptMap.get(a.employeeId.toHexString()) ?? 'Unassigned';
      const b = deptMap.get(dept);
      if (!b) continue;
      b.totalDays += 1;
      if (a.status === 'present' || a.status === 'half-day') b.presentDays += 1;
    }

    for (const l of leaveDocs) {
      const dept = userDeptMap.get(l.employeeId.toHexString()) ?? 'Unassigned';
      const b = deptMap.get(dept);
      if (b) b.leaveDays += l.totalDays;
    }

    const rows = Array.from(deptMap.entries())
      .map(([department, s]) => ({
        department,
        totalEmployees:      s.total,
        activeEmployees:     s.active,
        inactiveEmployees:   s.total - s.active,
        attendanceRate:      s.totalDays > 0
          ? Math.round((s.presentDays / s.totalDays) * 100 * 100) / 100
          : null,
        totalLeaveDaysTaken: s.leaveDays,
      }))
      .sort((a, b) => a.department.localeCompare(b.department));

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Department Summary');
    ws.columns = [
      { header: 'Department',           key: 'department',          width: 20 },
      { header: 'Total Employees',      key: 'totalEmployees',      width: 15 },
      { header: 'Active Employees',     key: 'activeEmployees',     width: 16 },
      { header: 'Inactive Employees',   key: 'inactiveEmployees',   width: 17 },
      { header: 'Attendance Rate (%)',  key: 'attendanceRate',      width: 18 },
      { header: 'Total Leave Days',     key: 'totalLeaveDaysTaken', width: 15 },
    ];
    ws.getRow(1).font = { bold: true };

    for (const r of rows) {
      ws.addRow({
        department:          r.department,
        totalEmployees:      r.totalEmployees,
        activeEmployees:     r.activeEmployees,
        inactiveEmployees:   r.inactiveEmployees,
        attendanceRate:      r.attendanceRate ?? 'N/A',
        totalLeaveDaysTaken: r.totalLeaveDaysTaken,
      });
    }

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    void writeAuditLog(userId, 'REPORT_EXPORTED', 'department-summary', query as Record<string, unknown>);
    return buffer;
  }

  // ── Regularization report ─────────────────────────────────────────────────────

  static async regularizationReport(userId: string, query: RegularizationReportQuery) {
    await connectDB();

    const filter: Record<string, unknown> = {};
    if (query.employeeId) filter.employeeId = new mongoose.Types.ObjectId(query.employeeId);
    if (query.status)     filter.status     = query.status;
    if (query.type)       filter.type       = query.type;
    if (query.startDate || query.endDate) {
      const range: Record<string, string> = {};
      if (query.startDate) range.$gte = query.startDate;
      if (query.endDate)   range.$lte = query.endDate;
      filter.dateString = range;
    }

    const skip = (query.page - 1) * query.limit;
    const [regs, total] = await Promise.all([
      mongoose.connection.collection('regularizations')
        .find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit).toArray(),
      mongoose.connection.collection('regularizations').countDocuments(filter),
    ]);

    const uniqueIds = [...new Set(regs.map((r) => String(r.employeeId)))];
    const users = await User.find({ _id: { $in: uniqueIds } }, '_id firstName lastName').lean() as { _id: mongoose.Types.ObjectId; firstName: string; lastName: string }[];
    const userMap = new Map(users.map((u) => [u._id.toHexString(), `${u.firstName} ${u.lastName}`]));

    const data = regs.map((r) => ({
      date:        String(r.dateString ?? ''),
      employeeName: userMap.get(String(r.employeeId)) ?? String(r.employeeId),
      type:        String(r.type ?? ''),
      status:      String(r.status ?? ''),
      reason:      String(r.reason ?? ''),
      reviewRemark: String(r.reviewRemark ?? ''),
      createdAt:   r.createdAt ? new Date(r.createdAt as Date).toISOString().slice(0, 10) : '',
    }));

    void writeAuditLog(userId, 'REPORT_VIEWED', 'regularization-report', query as Record<string, unknown>);
    return { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
  }

  static async regularizationExport(userId: string, query: RegularizationExportQuery): Promise<Buffer> {
    await connectDB();

    const fullQuery: RegularizationReportQuery = { ...query, page: 1, limit: 5000 };
    const { data } = await ReportService.regularizationReport(userId, fullQuery);

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Regularization Report');
    ws.addRow(['Date', 'Employee', 'Type', 'Status', 'Reason', 'Review Remark', 'Submitted']);
    ws.getRow(1).font = { bold: true };
    for (const r of data) ws.addRow([r.date, r.employeeName, r.type, r.status, r.reason, r.reviewRemark, r.createdAt]);
    ws.columns.forEach((c) => { c.width = 20; });

    const buffer = await wb.xlsx.writeBuffer();
    void writeAuditLog(userId, 'REPORT_EXPORTED', 'regularization-report', query as Record<string, unknown>);
    return Buffer.from(buffer as ArrayBuffer);
  }

  // ── Dashboard summary ─────────────────────────────────────────────────────────

  static async dashboardSummary(userId: string) {
    await connectDB();
    await reconcileMissedCheckouts(); // 24-hour rule before reporting (docs/85)

    const today      = new Date();
    const dateString = today.toISOString().slice(0, 10);
    const yearMonth  = dateString.slice(0, 7);

    const [
      totalEmployees,
      activeEmployees,
      todayPresent,
      todayAbsent,
      pendingLeaves,
      pendingRegularizations,
      payrollDraft,
      payrollFinalised,
    ] = await Promise.all([
      User.countDocuments({ role: 'employee' }),
      User.countDocuments({ role: 'employee', isActive: true }),
      AttendanceDay.countDocuments({ dateString, status: 'present' }),
      AttendanceDay.countDocuments({ dateString, status: 'absent' }),
      mongoose.connection.collection('leaves').countDocuments({ status: 'pending' }),
      mongoose.connection.collection('regularizations').countDocuments({ status: 'pending' }),
      PayrollRecord.countDocuments({ yearMonth, status: 'draft' }),
      PayrollRecord.countDocuments({ yearMonth, status: 'finalised' }),
    ]);

    void writeAuditLog(userId, 'REPORT_VIEWED', 'dashboard-summary', {});
    return {
      employees:        { total: totalEmployees, active: activeEmployees, inactive: totalEmployees - activeEmployees },
      todayAttendance:  { present: todayPresent, absent: todayAbsent, date: dateString },
      pendingApprovals: { leaves: Number(pendingLeaves), regularizations: Number(pendingRegularizations) },
      payroll:          { yearMonth, draft: payrollDraft, finalised: payrollFinalised },
    };
  }
}
