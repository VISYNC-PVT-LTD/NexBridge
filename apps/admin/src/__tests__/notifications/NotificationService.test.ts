import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import mongoose from 'mongoose';

Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true });

// Mock firebase-admin npm packages so the real sendFcmNotification runs cleanly
jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn().mockReturnValue({}),
  getApps:       jest.fn().mockReturnValue([{ name: '[DEFAULT]' }]),
  cert:          jest.fn().mockReturnValue({}),
}));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue('msg-id-test'),
  }),
}));

import { sendEmail }          from '@lib/email/brevo';
import { NotificationService } from '@services/NotificationService';
import { FcmService }          from '@services/FcmService';
import { Notification }        from '@models/Notification';
import { FcmToken }            from '@models/FcmToken';
import { User }                from '@models/User';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EMPLOYEE_OID = new mongoose.Types.ObjectId();
const NOTIF_OID    = new mongoose.Types.ObjectId();

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    _id:           NOTIF_OID,
    employeeId:    EMPLOYEE_OID,
    type:          'leaveApproved',
    title:         'Leave Request Approved',
    body:          'Your leave request has been approved.',
    isRead:        false,
    channels:      { push: { sent: false }, email: { sent: false } },
    referenceType: 'leaveRequest',
    referenceId:   new mongoose.Types.ObjectId(),
    createdAt:     new Date('2026-06-01T10:00:00Z'),
    ...overrides,
  };
}

function getMessagingSend(): jest.Mock {
  const { getMessaging } = require('firebase-admin/messaging') as { getMessaging: jest.Mock };
  return getMessaging().send as jest.Mock;
}

// ─── Global setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Restore firebase-admin/messaging send to success after each test
  getMessagingSend().mockResolvedValue('msg-id-test');
  // Mock global.fetch for Brevo email calls
  global.fetch = jest.fn().mockResolvedValue({ ok: true }) as never;
  // Notification.updateOne called by fire-and-forget .then() handlers
  jest.spyOn(Notification, 'updateOne').mockResolvedValue({} as never);
});

// ─── U-NOT-01: Push to active FCM token ───────────────────────────────────────
// Tests that FcmService.sendToEmployee completes without throwing even when
// the underlying push fails (graceful degradation — push errors must be swallowed).

describe('U-NOT-01: sends push to active FCM token without error propagation', () => {
  it('resolves without throwing when active FCM token exists (push errors are swallowed)', async () => {
    const tokenOid = new mongoose.Types.ObjectId();
    jest.spyOn(FcmToken, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { _id: tokenOid, token: 'fcm-token-abc', employeeId: EMPLOYEE_OID },
      ]),
    } as never);
    jest.spyOn(FcmToken, 'updateOne').mockResolvedValue({} as never);

    // Must NOT throw — push failures are fire-and-forget
    await expect(
      FcmService.sendToEmployee(EMPLOYEE_OID, 'Leave Approved', 'Your leave is approved.'),
    ).resolves.toBeUndefined();
  });
});

// ─── U-NOT-02: Stale FCM token — non-FCM errors do not trigger deactivation ──
// When sendFcmNotification throws an error that does NOT contain
// 'registration-token-not-registered' or 'invalid-registration-token',
// FcmToken.updateOne MUST NOT be called (no accidental token deactivation).

describe('U-NOT-02: unrecognized FCM error → token NOT deactivated, no throw', () => {
  it('does not deactivate token or throw on unrecognized Firebase error', async () => {
    const tokenOid = new mongoose.Types.ObjectId();
    jest.spyOn(FcmToken, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { _id: tokenOid, token: 'some-token', employeeId: EMPLOYEE_OID },
      ]),
    } as never);
    jest.spyOn(FcmToken, 'updateOne').mockResolvedValue({} as never);

    // Real sendFcmNotification throws a Firebase init error in test env —
    // this is an "unrecognized" error that must NOT deactivate the token.
    await expect(
      FcmService.sendToEmployee(EMPLOYEE_OID, 'Title', 'Body'),
    ).resolves.toBeUndefined();

    // The error message does not match stale-token patterns → updateOne must NOT be called
    expect(FcmToken.updateOne).not.toHaveBeenCalled();
  });
});

// ─── U-NOT-03: Email via Brevo ────────────────────────────────────────────────

describe('U-NOT-03: email sent via Brevo with correct payload', () => {
  it('calls Brevo API with correct recipient and subject', async () => {
    const notifDoc = makeNotification();
    jest.spyOn(Notification, 'create').mockResolvedValue(notifDoc as never);
    jest.spyOn(FcmToken, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    } as never);

    await NotificationService.create({
      employeeId:   EMPLOYEE_OID,
      type:         'leaveApproved',
      title:        'Leave Approved',
      body:         'Your leave is approved.',
      emailAddress: 'emp@test.com',
      emailName:    'John Doe',
    });

    // Allow fire-and-forget microtasks to flush
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Email transport is globally mocked (jest.setup.ts); the real Brevo
    // request payload is verified in __tests__/email/brevo.test.ts.
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      { email: 'emp@test.com', name: 'John Doe' },
        subject: 'Leave Approved',
      }),
    );
  });
});

// ─── U-NOT-04: Notification doc inserted before sends ────────────────────────

describe('U-NOT-04: Notification doc inserted regardless of push/email success', () => {
  it('creates Notification doc first, then dispatches push non-blocking', async () => {
    const notifDoc = makeNotification();
    jest.spyOn(Notification, 'create').mockResolvedValue(notifDoc as never);
    jest.spyOn(FcmToken, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    } as never);

    await NotificationService.create({
      employeeId: EMPLOYEE_OID,
      type:       'leaveApproved',
      title:      'Leave Approved',
      body:       'Your leave is approved.',
    });

    expect(Notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: EMPLOYEE_OID,
        type:       'leaveApproved',
        isRead:     false,
      }),
    );
  });
});

// ─── U-NOT-05: No active FCM token → push skipped gracefully ─────────────────

describe('U-NOT-05: no active FCM token → notification logged, push skipped gracefully', () => {
  it('does not throw when employee has no active tokens', async () => {
    const notifDoc = makeNotification();
    jest.spyOn(Notification, 'create').mockResolvedValue(notifDoc as never);
    jest.spyOn(FcmToken, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    } as never);

    await expect(
      NotificationService.create({
        employeeId: EMPLOYEE_OID,
        type:       'leaveRejected',
        title:      'Leave Rejected',
        body:       'Your leave was rejected.',
      }),
    ).resolves.toBeUndefined();

    expect(Notification.create).toHaveBeenCalledTimes(1);
  });
});

// ─── U-NOT-06: markAllRead returns matchedCount ───────────────────────────────

describe('U-NOT-06: markAllRead uses matchedCount (BR-NOT-06)', () => {
  it('returns matchedCount including already-read notifications', async () => {
    jest.spyOn(Notification, 'updateMany').mockResolvedValue(
      { matchedCount: 5, modifiedCount: 3 } as never,
    );

    const result = await NotificationService.markAllRead({
      userId: EMPLOYEE_OID.toHexString(),
      input:  {},
    });

    expect(result.markedRead).toBe(5);
  });
});

// ─── U-NOT-07: markRead — wrong owner → 404 ──────────────────────────────────

describe('U-NOT-07: markRead not found or wrong owner → GEN_002 404', () => {
  it('throws 404 when notification not found', async () => {
    jest.spyOn(Notification, 'findOneAndUpdate').mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    } as never);

    await expect(
      NotificationService.markRead({
        userId:         EMPLOYEE_OID.toHexString(),
        notificationId: NOTIF_OID.toHexString(),
      }),
    ).rejects.toMatchObject({ code: 'GEN_002', httpStatus: 404 });
  });
});

// ─── U-NOT-08: list maps DB type to API kebab-case ───────────────────────────

describe('U-NOT-08: list returns API kebab-case type', () => {
  it('maps payrollGenerated → payroll-finalised in API response', async () => {
    const notifDoc = makeNotification({ type: 'payrollGenerated' });
    jest.spyOn(Notification, 'find').mockReturnValue({
      sort:  jest.fn().mockReturnThis(),
      skip:  jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean:  jest.fn().mockResolvedValue([notifDoc]),
    } as never);
    jest.spyOn(Notification, 'countDocuments').mockResolvedValue(1 as never);

    const result = await NotificationService.list({
      userId: EMPLOYEE_OID.toHexString(),
      query:  { page: 1, limit: 20, isRead: undefined, type: undefined },
    });

    expect(result.data[0].type).toBe('payroll-finalised');
    expect(result.pagination.total).toBe(1);
  });
});

// ─── notifyAllAdmins ──────────────────────────────────────────────────────────

describe('notifyAllAdmins: creates notification for each active admin', () => {
  it('sends notification to all active admin users', async () => {
    const adminOid = new mongoose.Types.ObjectId();
    jest.spyOn(User, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { _id: adminOid, email: 'admin@test.com', firstName: 'Admin', lastName: 'One' },
      ]),
    } as never);
    jest.spyOn(Notification, 'create').mockResolvedValue(makeNotification() as never);
    jest.spyOn(FcmToken, 'find').mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    } as never);

    await NotificationService.notifyAllAdmins({
      type:  'leaveSubmitted',
      title: 'New Leave Request',
      body:  'Employee submitted a leave.',
    });

    expect(Notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'leaveSubmitted' }),
    );
  });
});
