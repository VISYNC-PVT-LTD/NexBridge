import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ListEmployeesSchema } from '@validators/employee';
import { EmployeeService } from '@services/EmployeeService';
import { AppError } from '@services/AuthService';
import { getAuthUser, AuthError } from '@mw/requireAuth';
import { isAttendanceAdmin } from '@mw/requireRole';
import { apiError } from '@lib/utils/api-response';
import { format } from 'date-fns';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  let payload;
  try {
    payload = await getAuthUser(request);
  } catch (err) {
    if (err instanceof AuthError) return apiError(err.code, 'Unauthorized.', err.httpStatus);
    throw err;
  }

  if (!isAttendanceAdmin(payload.role)) return apiError('AUTH_006', 'Forbidden.', 403);

  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  let baseQuery;
  try {
    baseQuery = ListEmployeesSchema.parse(sp);
  } catch (err) {
    if (err instanceof ZodError) return apiError('GEN_001', 'Validation failed.', 400);
    throw err;
  }
  const query = { ...baseQuery, limit: 10000, page: 1 };

  try {
    const result = await EmployeeService.list(query, 'admin');
    const employees = result.data;

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees');

    ws.columns = [
      { header: 'Employee ID',  key: 'employeeId',  width: 14 },
      { header: 'First Name',   key: 'firstName',   width: 16 },
      { header: 'Last Name',    key: 'lastName',     width: 16 },
      { header: 'Email',        key: 'email',        width: 28 },
      { header: 'Phone',        key: 'phone',        width: 16 },
      { header: 'Department',   key: 'department',   width: 18 },
      { header: 'Designation',  key: 'designation',  width: 18 },
      { header: 'Role',         key: 'role',         width: 10 },
      { header: 'Status',       key: 'status',       width: 10 },
      { header: 'Joining Date', key: 'joiningDate',  width: 14 },
      { header: 'Created At',   key: 'createdAt',    width: 20 },
    ];

    ws.getRow(1).font = { bold: true };

    for (const emp of employees as Record<string, unknown>[]) {
      ws.addRow({
        employeeId:  emp['employeeId'] ?? '',
        firstName:   emp['firstName'] ?? '',
        lastName:    emp['lastName']  ?? '',
        email:       emp['email']     ?? '',
        phone:       emp['phone']     ?? '',
        department:  emp['department'] ?? '',
        designation: emp['designation'] ?? '',
        role:        emp['role']      ?? '',
        status:      emp['isActive']  ? 'Active' : 'Inactive',
        joiningDate: emp['joiningDate'] ? format(new Date(emp['joiningDate'] as string), 'yyyy-MM-dd') : '',
        createdAt:   emp['createdAt']   ? format(new Date(emp['createdAt']   as string), 'yyyy-MM-dd HH:mm') : '',
      });
    }

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `employees-${format(new Date(), 'yyyy-MM-dd')}.xlsx`;

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
