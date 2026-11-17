import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/shared/widgets/loading_overlay.dart';

Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

/// (background, text) colours actually rendered for the chip showing [label].
(Color, Color) _colours(WidgetTester tester, String label) {
  final text = tester.widget<Text>(find.text(label));
  final box = tester.widget<Container>(find.ancestor(of: find.text(label), matching: find.byType(Container)).first);
  return ((box.decoration! as BoxDecoration).color!, text.style!.color!);
}

double _contrast(Color a, Color b) {
  double lum(Color c) {
    double ch(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  final x = lum(a), y = lum(b);
  return (math.max(x, y) + 0.05) / (math.min(x, y) + 0.05);
}

void main() {
  group('StatusChip', () {
    testWidgets('shows Present label for present status', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'present')));
      expect(find.text('Present'), findsOneWidget);
    });

    testWidgets('shows Absent label for absent status', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'absent')));
      expect(find.text('Absent'), findsOneWidget);
    });

    testWidgets('shows Half Day for half_day', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'half_day')));
      expect(find.text('Half Day'), findsOneWidget);
    });

    testWidgets('shows Half Day for half-day variant', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'half-day')));
      expect(find.text('Half Day'), findsOneWidget);
    });

    testWidgets('shows Approved for approved', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'approved')));
      expect(find.text('Approved'), findsOneWidget);
    });

    testWidgets('shows Pending for pending', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'pending')));
      expect(find.text('Pending'), findsOneWidget);
    });

    testWidgets('shows Rejected for rejected', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'rejected')));
      expect(find.text('Rejected'), findsOneWidget);
    });

    testWidgets('shows Leave for leave', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'leave')));
      expect(find.text('Leave'), findsOneWidget);
    });

    testWidgets('shows Holiday for holiday', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'holiday')));
      expect(find.text('Holiday'), findsOneWidget);
    });

    testWidgets('shows Weekend for weekend', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'weekend')));
      expect(find.text('Weekend'), findsOneWidget);
    });

    testWidgets('shows Cancelled for cancelled', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'cancelled')));
      expect(find.text('Cancelled'), findsOneWidget);
    });

    testWidgets('shows Draft for draft', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'draft')));
      expect(find.text('Draft'), findsOneWidget);
    });

    testWidgets('echoes unknown status', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'unknown_xyz')));
      expect(find.text('unknown_xyz'), findsOneWidget);
    });

    testWidgets('case insensitive — PRESENT resolves to Present', (tester) async {
      await tester.pumpWidget(wrap(const StatusChip(status: 'PRESENT')));
      expect(find.text('Present'), findsOneWidget);
    });

    testWidgets('empty or blank status renders "Unknown" instead of failing', (tester) async {
      for (final s in ['', '   ']) {
        await tester.pumpWidget(wrap(StatusChip(status: s)));
        expect(find.text('Unknown'), findsOneWidget, reason: 'status "$s"');
      }
    });

    testWidgets('withdrawn and revoked have distinct, readable styles', (tester) async {
      await tester.pumpWidget(wrap(const Column(children: [StatusChip(status: 'withdrawn'), StatusChip(status: 'revoked')])));
      final w = _colours(tester, 'Withdrawn');
      final r = _colours(tester, 'Revoked');
      expect(w, isNot(r));
    });

    // WCAG AA for 12px text: contrast >= 4.5:1. Regression: weekend/cancelled/
    // withdrawn used gray-500 on gray-100 (4.39:1).
    testWidgets('every known status meets WCAG AA contrast', (tester) async {
      const statuses = {
        'present': 'Present', 'absent': 'Absent', 'checked-in': 'Active', 'half_day': 'Half Day',
        'leave': 'Leave', 'holiday': 'Holiday', 'weekend': 'Weekend', 'pending': 'Pending',
        'approved': 'Approved', 'rejected': 'Rejected', 'cancelled': 'Cancelled', 'withdrawn': 'Withdrawn',
        'revoked': 'Revoked', 'finalised': 'Finalised', 'draft': 'Draft', 'something_new': 'something_new', '': 'Unknown',
      };
      for (final e in statuses.entries) {
        await tester.pumpWidget(wrap(StatusChip(status: e.key)));
        final (bg, fg) = _colours(tester, e.value);
        expect(_contrast(bg, fg), greaterThanOrEqualTo(4.5), reason: '"${e.key}" contrast ${_contrast(bg, fg).toStringAsFixed(2)}');
      }
    });
  });
}
