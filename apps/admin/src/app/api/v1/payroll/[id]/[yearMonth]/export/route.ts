import { NextRequest, NextResponse } from 'next/server';
import { format } from 'date-fns';
import { PayrollService } from '@services/PayrollService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { assertAttendanceAdmin } from '@mw/requireRole';
import { apiError } from '@lib/utils/api-response';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; yearMonth: string }> },
): Promise<NextResponse> {
  let payload;
  try { payload = await getAuthUser(request); }
  catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  try { assertAttendanceAdmin(payload); }
  catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  const { id, yearMonth } = await context.params;

  if (!/^[0-9a-f]{24}$/i.test(id)) return apiError('GEN_001', 'Invalid payroll record id.', 400);
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) return apiError('GEN_001', 'Invalid yearMonth format.', 400);

  let record;
  try {
    record = await PayrollService.getByRecordId(id);
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }

  try {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Payslip');

    const snap = record.employeeSnapshot as { firstName: string; lastName: string; employeeId: string; department: string; designation: string; monthlySalary: number } | undefined;
    const empName = snap ? `${snap.firstName} ${snap.lastName}` : '—';
    const empCode = snap?.employeeId ?? '—';
    const dept    = snap?.department  ?? '—';
    const desig   = snap?.designation ?? '—';

    // Info section
    ws.addRow(['Payslip']);
    ws.getRow(1).font = { bold: true, size: 14 };
    ws.addRow([]);
    ws.addRow(['Employee',    empName]);
    ws.addRow(['Employee ID', empCode]);
    ws.addRow(['Department',  dept]);
    ws.addRow(['Designation', desig]);
    ws.addRow(['Period',      record.yearMonth]);
    ws.addRow(['Status',      record.status]);
    ws.addRow([]);

    // Attendance
    ws.addRow(['Attendance Summary']);
    ws.getRow(ws.rowCount).font = { bold: true };
    ws.addRow(['Working Days',  record.workingDays]);
    ws.addRow(['Present Days',  record.presentDays]);
    ws.addRow(['Absent Days',   record.absentDays]);
    ws.addRow(['Leave Days',    record.leaveDays]);
    ws.addRow(['Half Days',     record.halfDays]);
    ws.addRow(['LWP Days',      record.lopDays]);
    ws.addRow([]);

    // Salary
    ws.addRow(['Salary Breakdown']);
    ws.getRow(ws.rowCount).font = { bold: true };
    ws.addRow(['Gross Salary',      record.grossSalary]);
    if ((record.manualDeduction ?? 0) > 0) {
      ws.addRow(['Manual Deduction', record.manualDeduction]);
      if (record.manualDeductionRemark) {
        ws.addRow(['Deduction Remark', record.manualDeductionRemark]);
      }
    }
    ws.addRow(['Total Deductions',  record.deductions]);
    ws.addRow(['Net Salary',        record.netSalary]);
    ws.addRow([]);

    // Meta
    ws.addRow(['Computed At',   record.computedAt ? format(new Date(record.computedAt), 'dd MMM yyyy HH:mm') : '—']);
    if (record.finalisedAt) {
      ws.addRow(['Finalised At', format(new Date(record.finalisedAt), 'dd MMM yyyy HH:mm')]);
    }

    ws.getColumn(1).width = 20;
    ws.getColumn(2).width = 28;

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `payslip-${record.yearMonth}-${empCode}.xlsx`;

    return new NextResponse(new Uint8Array(buffer as ArrayBuffer), {
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    if (err instanceof AppError) return apiError(err.code, err.message, err.httpStatus);
    throw err;
  }
}
