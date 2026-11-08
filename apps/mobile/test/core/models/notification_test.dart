import 'package:flutter_test/flutter_test.dart';
import 'package:genesis_workforce/core/models/notification.dart';

void main() {
  group('AppNotification.fromJson', () {
    final json = {
      'id': 'n1', // server formatNotification() returns 'id'
      'userId': 'u1',
      'title': 'Leave Approved',
      'body': 'Your casual leave has been approved.',
      'isRead': false,
      'type': 'leave_approved',
      'relatedEntityId': 'l1', // server field name (formatNotification)
      'createdAt': '2026-06-20T10:00:00Z',
    };

    test('parses all fields', () {
      final n = AppNotification.fromJson(json);
      expect(n.id, 'n1');
      expect(n.title, 'Leave Approved');
      expect(n.isRead, isFalse);
      expect(n.type, 'leave_approved');
      expect(n.referenceId, 'l1');
    });

    test('referenceId nullable', () {
      final n = AppNotification.fromJson({...json}..remove('relatedEntityId'));
      expect(n.referenceId, isNull);
    });

    test('defaults on missing fields', () {
      final n = AppNotification.fromJson({});
      expect(n.id, '');
      expect(n.isRead, isFalse);
    });
  });

  group('CompanySettings.fromJson', () {
    test('calculates requiredDailyMinutes from shift', () {
      final s = CompanySettings.fromJson({
        'shift': {'startTime': '09:00', 'endTime': '18:00', 'gracePeriodMinutes': 15},
        'geofence': {'enabled': false},
        'workingDays': ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        'regularizationLookbackDays': 7,
      });
      expect(s.requiredDailyMinutes, 540); // 9h
    });

    test('different shift times', () {
      final s = CompanySettings.fromJson({
        'shift': {'startTime': '08:30', 'endTime': '17:30'},
      });
      expect(s.requiredDailyMinutes, 540); // 9h
    });

    test('geofence enabled parses coords', () {
      final s = CompanySettings.fromJson({
        'geofence': {'enabled': true, 'lat': 19.076, 'lng': 72.877, 'radiusMeters': 200},
      });
      expect(s.geofenceEnabled, isTrue);
      expect(s.officeLat, 19.076);
      expect(s.officeLng, 72.877);
      expect(s.geofenceRadiusMeters, 200);
    });

    test('defaults static getter', () {
      final s = CompanySettings.defaults;
      expect(s.requiredDailyMinutes, 540);
      expect(s.geofenceEnabled, isFalse);
      expect(s.regularizationLookbackDays, 7);
      expect(s.workingDays, contains('monday'));
    });

    test('defaults on empty json', () {
      final s = CompanySettings.fromJson({});
      expect(s.requiredDailyMinutes, 540);
      expect(s.geofenceEnabled, isFalse);
    });
  });
}
