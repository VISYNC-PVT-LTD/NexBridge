import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/models/payroll.dart';

void main() {
  PayslipRecord makeRecord({
    double presentDays = 0,
    double leaveDays = 0,
    double halfDays = 0,
  }) =>
      PayslipRecord(
        id: 'p1',
        employeeId: 'e1',
        yearMonth: '2026-06',
        status: 'finalised',
        workingDays: 22,
        presentDays: presentDays,
        absentDays: 0,
        leaveDays: leaveDays,
        halfDays: halfDays,
        lopDays: 0,
        grossSalary: 50000,
        netSalary: 45000,
        deductions: 5000,
        earnings: {'Basic': 30000, 'HRA': 15000, 'Allowances': 5000},
        deductionBreakdown: {'PF': 3600, 'TDS': 1400},
        createdAt: '2026-07-01T00:00:00Z',
      );

  group('PayslipRecord.payableDays', () {
    test('present only', () {
      expect(makeRecord(presentDays: 20).payableDays, 20.0);
    });

    test('present + leave', () {
      expect(makeRecord(presentDays: 18, leaveDays: 2).payableDays, 20.0);
    });

    test('half days counted as 0.5 each', () {
      expect(makeRecord(presentDays: 19, halfDays: 2).payableDays, 20.0);
    });

    test('full combination', () {
      expect(makeRecord(presentDays: 17, leaveDays: 2, halfDays: 2).payableDays, 20.0);
    });
  });

  group('PayslipRecord.fromJson', () {
    final json = {
      'id': 'p1', // server PayrollService.formatRecord() returns 'id'
      'employeeId': 'e1',
      'yearMonth': '2026-06',
      'status': 'finalised',
      'workingDays': 22,
      'presentDays': 20,
      'absentDays': 2,
      'leaveDays': 0,
      'halfDays': 0,
      'lopDays': 0,
      'grossSalary': 50000.0,
      'netSalary': 45000.0,
      'deductions': 5000.0,
      'earnings': {'Basic': 30000.0, 'HRA': 15000.0},
      'deductionBreakdown': {'PF': 3600.0},
      'createdAt': '2026-07-01T00:00:00Z',
    };

    test('parses all fields', () {
      final p = PayslipRecord.fromJson(json);
      expect(p.id, 'p1');
      expect(p.yearMonth, '2026-06');
      expect(p.presentDays, 20.0);
      expect(p.grossSalary, 50000.0);
      expect(p.earnings['Basic'], 30000.0);
      expect(p.deductionBreakdown['PF'], 3600.0);
    });

    test('handles nested employeeId object', () {
      final j = {...json, 'employeeId': {'_id': 'e99', 'name': 'Acme'}};
      expect(PayslipRecord.fromJson(j).employeeId, 'e99');
    });

    test('defaults to zero on missing numeric fields', () {
      final p = PayslipRecord.fromJson({'id': 'x', 'yearMonth': '2026-01'});
      expect(p.grossSalary, 0.0);
      expect(p.payableDays, 0.0);
    });
  });
}
