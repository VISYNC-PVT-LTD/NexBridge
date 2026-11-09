import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/shared/widgets/confirm_dialog.dart';

/// A page inside a NESTED navigator, like go_router's shell routes: dialogs go
/// to the root navigator, the page lives in the inner one.
Widget _nestedApp(Widget Function(BuildContext pageContext) page) {
  return MaterialApp(
    home: Navigator(
      onGenerateRoute: (_) => MaterialPageRoute(builder: (ctx) => Scaffold(body: Builder(builder: page))),
    ),
  );
}

void main() {
  // Regression (found on a real phone): "Cancel Leave?" / "Withdraw?" popped
  // the PAGE (outer context) instead of the dialog: no request was sent and the
  // dialog stayed on screen.
  testWidgets('confirm: returns true, closes the dialog, keeps the page', (tester) async {
    bool? result;
    await tester.pumpWidget(_nestedApp((ctx) => TextButton(
          onPressed: () async => result = await showConfirmDialog(ctx, title: 'Cancel Leave?', message: 'Sure?', confirmLabel: 'Yes, Cancel'),
          child: const Text('open'),
        )));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes, Cancel'));
    await tester.pumpAndSettle();

    expect(result, isTrue);
    expect(find.text('Cancel Leave?'), findsNothing); // dialog closed
    expect(find.text('open'), findsOneWidget);        // page still there
  });

  testWidgets('cancel: returns false', (tester) async {
    bool? result;
    await tester.pumpWidget(_nestedApp((ctx) => TextButton(
          onPressed: () async => result = await showConfirmDialog(ctx, title: 'Withdraw?', message: 'Sure?', confirmLabel: 'Yes, Withdraw'),
          child: const Text('open'),
        )));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('No'));
    await tester.pumpAndSettle();
    expect(result, isFalse);
    expect(find.text('Withdraw?'), findsNothing);
  });

  testWidgets('control: the OLD pattern (pop with the page context) leaves the dialog open', (tester) async {
    bool? result;
    await tester.pumpWidget(_nestedApp((ctx) => TextButton(
          onPressed: () async => result = await showDialog<bool>(
            context: ctx,
            builder: (_) => AlertDialog(title: const Text('Old'), actions: [
              TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Yes')),
            ]),
          ),
          child: const Text('open'),
        )));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes'));
    await tester.pumpAndSettle();
    expect(result, isNull);                    // confirmation never resolved
    expect(find.text('Old'), findsOneWidget);  // dialog still on screen
  });
}
