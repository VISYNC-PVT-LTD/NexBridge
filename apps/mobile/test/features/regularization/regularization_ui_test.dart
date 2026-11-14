import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart';
import 'package:genesis_workforce/core/models/regularization.dart';
import 'package:genesis_workforce/features/leave/presentation/screens/leave_apply_screen.dart';
import 'package:genesis_workforce/features/regularization/presentation/screens/regularization_create_screen.dart';
import 'package:genesis_workforce/shared/widgets/loading_overlay.dart';

// UI cleanup found in phone testing: raw regularization labels ("CLIENTVISIT",
// lowercase "withdrawn", ISO timestamps) and validation errors that stayed on
// screen after the user had fixed the field.
Widget _app(Widget screen) => ProviderScope(child: MaterialApp(home: screen));

void main() {
  group('regularizationTypeLabel', () {
    test('every API type has a readable label', () {
      expect(regularizationTypeLabel('forgotCheckIn'), 'Forgot Check-In');
      expect(regularizationTypeLabel('forgotCheckOut'), 'Forgot Check-Out');
      expect(regularizationTypeLabel('workAwayFromOffice'), 'Work Away From Office');
      expect(regularizationTypeLabel('officialTravel'), 'Official Travel');
      expect(regularizationTypeLabel('clientVisit'), 'Client Visit');
    });
    test('unknown types are shown as-is', () => expect(regularizationTypeLabel('managementDuty'), 'managementDuty'));
  });

  group('formatRequestedTime', () {
    test('shows the instant in local time, not the raw ISO string', () {
      const iso = '2026-11-08T13:00:00.000Z';
      final expected = DateFormat('dd MMM, HH:mm').format(DateTime.parse(iso).toLocal());
      expect(formatRequestedTime(iso), expected);
      expect(formatRequestedTime(iso), isNot(contains('T13')));
    });
    test('unparseable values are shown unchanged', () => expect(formatRequestedTime('n/a'), 'n/a'));
  });

  group('StatusChip', () {
    testWidgets('withdrawn and revoked are capitalised', (tester) async {
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: Column(children: const [
        StatusChip(status: 'withdrawn'),
        StatusChip(status: 'revoked'),
      ]))));
      expect(find.text('Withdrawn'), findsOneWidget);
      expect(find.text('Revoked'), findsOneWidget);
      expect(find.text('withdrawn'), findsNothing);
    });
  });

  group('stale validation errors are cleared when the user edits', () {
    testWidgets('regularization form', (tester) async {
      await tester.pumpWidget(_app(const RegularizationCreateScreen(initialDate: '2026-11-05', initialType: 'clientVisit')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Submit Request'));
      await tester.pump();
      expect(find.text('Reason is required.'), findsOneWidget);

      await tester.enterText(find.byType(TextFormField).last, 'Client visit at supplier site');
      await tester.pump();
      expect(find.text('Reason is required.'), findsNothing);
    });

    testWidgets('leave form', (tester) async {
      await tester.pumpWidget(_app(const LeaveApplyScreen()));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Submit Request'));
      await tester.pump();
      expect(find.text('Select start and end dates.'), findsOneWidget);

      await tester.enterText(find.byType(TextFormField).last, 'Family function');
      await tester.pump();
      expect(find.text('Select start and end dates.'), findsNothing);
    });
  });
}
