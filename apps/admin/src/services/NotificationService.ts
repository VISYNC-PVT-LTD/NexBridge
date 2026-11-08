import mongoose from 'mongoose';
import { connectDB } from '@lib/db/connect';
import { sendEmail } from '@lib/email/brevo';
import { Notification } from '@models/Notification';
import { User } from '@models/User';
import { FcmService } from '@services/FcmService';
import { AppError } from '@services/AuthService';
import type { INotification, NotificationType } from '@models/Notification';
import type { NotificationListQuery, MarkAllReadInput } from '@validators/notification';

// ─── Type mapping (DB camelCase → API kebab-case) ─────────────────────────────

const TYPE_TO_API: Record<NotificationType, string> = {
  leaveApproved:             'leave-approved',
  leaveRejected:             'leave-rejected',
  leaveSubmitted:            'leave-submitted',
  leaveRevoked:              'leave-revoked',
  regularizationApproved:   'regularization-approved',
  regularizationRejected:   'regularization-rejected',
  regularizationSubmitted:  'regularization-submitted',
  attendanceReminder:        'attendance-reminder',
  passwordReset:             'password-reset',
  payrollGenerated:          'payroll-finalised',
  accountActivated:          'account-activated',
  accountDeactivated:        'account-deactivated',
};

const API_TO_TYPE: Record<string, NotificationType> = Object.fromEntries(
  Object.entries(TYPE_TO_API).map(([k, v]) => [v, k as NotificationType]),
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatNotification(n: INotification & { _id: mongoose.Types.ObjectId }) {
  return {
    id:               n._id.toHexString(),
    type:             TYPE_TO_API[n.type] ?? n.type,
    title:            n.title,
    body:             n.body,
    isRead:           n.isRead,
    relatedEntityType: n.referenceType ?? null,
    relatedEntityId:  n.referenceId?.toHexString() ?? null,
    createdAt:        n.createdAt.toISOString(),
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreateNotificationParams {
  employeeId: mongoose.Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  referenceType?: 'leaveRequest' | 'regularizationRequest' | 'payrollSummary';
  referenceId?: mongoose.Types.ObjectId;
  emailAddress?: string;
  emailName?: string;
}

// ─── Fire-and-forget safety ──────────────────────────────────────────────────

/**
 * Rejection handler for fire-and-forget notification dispatch
 * (`void NotificationService.create(...).catch(logNotificationFailure)`).
 * Without it a DB/push failure becomes an unhandled promise rejection, which
 * can terminate the Node process. Logs only the error class — never the
 * notification body, recipient or email address.
 */
export function logNotificationFailure(err: unknown): void {
  console.error('[notification] dispatch failed:', err instanceof Error ? err.name : 'unknown error');
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class NotificationService {
  // ─── Create ────────────────────────────────────────────────────────────────

  static async create(params: CreateNotificationParams): Promise<void> {
    await connectDB();

    const doc = await Notification.create({
      employeeId:    params.employeeId,
      type:          params.type,
      title:         params.title,
      body:          params.body,
      referenceType: params.referenceType,
      referenceId:   params.referenceId,
      isRead:        false,
      channels: {
        push:  { sent: false },
        email: { sent: false },
      },
    });

    const notifId = (doc as INotification & { _id: mongoose.Types.ObjectId })._id;

    // Push — non-blocking, errors swallowed
    const fcmData: Record<string, string> = {
      type: TYPE_TO_API[params.type] ?? params.type,
    };
    if (params.referenceId) fcmData.referenceId = params.referenceId.toHexString();

    void FcmService.sendToEmployee(params.employeeId, params.title, params.body, fcmData)
      .then(() =>
        Notification.updateOne(
          { _id: notifId },
          { $set: { 'channels.push.sent': true, 'channels.push.sentAt': new Date() } },
        ),
      )
      .catch(async (err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        await Notification.updateOne(
          { _id: notifId },
          { $set: { 'channels.push.error': error } },
        );
      });

    // Email — non-blocking, errors swallowed
    if (params.emailAddress) {
      void sendEmail({
        to:          { email: params.emailAddress, name: params.emailName },
        subject:     params.title,
        htmlContent: `<p>${params.body}</p>`,
      })
        .then(() =>
          Notification.updateOne(
            { _id: notifId },
            { $set: { 'channels.email.sent': true, 'channels.email.sentAt': new Date() } },
          ),
        )
        .catch(async (err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          await Notification.updateOne(
            { _id: notifId },
            { $set: { 'channels.email.error': error } },
          );
        });
    }
  }

  // ─── Notify all admins ────────────────────────────────────────────────────

  static async notifyAllAdmins(params: Omit<CreateNotificationParams, 'employeeId'>): Promise<void> {
    await connectDB();

    const admins = await User.find({ role: 'admin', isActive: true }, '_id email firstName lastName').lean() as unknown as Array<{
      _id: mongoose.Types.ObjectId;
      email: string;
      firstName: string;
      lastName: string;
    }>;

    await Promise.allSettled(
      admins.map((admin) =>
        NotificationService.create({
          ...params,
          employeeId:   admin._id,
          emailAddress: admin.email,
          emailName:    `${admin.firstName} ${admin.lastName}`,
        }),
      ),
    );
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  static async list(params: { userId: string; query: NotificationListQuery }) {
    await connectDB();

    const filter: Record<string, unknown> = {
      employeeId: new mongoose.Types.ObjectId(params.userId),
    };

    if (params.query.isRead !== undefined) {
      filter.isRead = params.query.isRead;
    }

    if (params.query.type) {
      const dbType = API_TO_TYPE[params.query.type];
      if (dbType) filter.type = dbType;
      else filter.type = null; // unknown type → return empty
    }

    const page  = params.query.page;
    const limit = params.query.limit;
    const skip  = (page - 1) * limit;

    const [docs, total] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean() as unknown as Promise<(INotification & { _id: mongoose.Types.ObjectId })[]>,
      Notification.countDocuments(filter),
    ]);

    return {
      data: docs.map(formatNotification),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─── Mark single read ─────────────────────────────────────────────────────

  static async markRead(params: { userId: string; notificationId: string }) {
    await connectDB();

    if (!/^[0-9a-f]{24}$/i.test(params.notificationId)) {
      throw new AppError('GEN_001', 400, 'Invalid notification id.');
    }

    const result = await Notification.findOneAndUpdate(
      {
        _id:        new mongoose.Types.ObjectId(params.notificationId),
        employeeId: new mongoose.Types.ObjectId(params.userId),
      },
      { $set: { isRead: true, readAt: new Date() } },
      { new: true },
    ).lean() as (INotification & { _id: mongoose.Types.ObjectId }) | null;

    if (!result) throw new AppError('GEN_002', 404, 'Notification not found.');

    return formatNotification(result);
  }

  // ─── Mark all read ────────────────────────────────────────────────────────

  static async markAllRead(params: { userId: string; input: MarkAllReadInput }) {
    await connectDB();

    const employeeOid = new mongoose.Types.ObjectId(params.userId);
    const filter: Record<string, unknown> = { employeeId: employeeOid };

    if (params.input.ids && params.input.ids.length > 0) {
      const validOids = params.input.ids
        .filter((id) => /^[0-9a-f]{24}$/i.test(id))
        .map((id) => new mongoose.Types.ObjectId(id));
      filter._id = { $in: validOids };
    }

    // BR-NOT-06: matchedCount includes already-read docs per spec
    const result = await Notification.updateMany(
      filter,
      { $set: { isRead: true, readAt: new Date() } },
    );

    return { markedRead: result.matchedCount };
  }

  // ─── Unread count ─────────────────────────────────────────────────────────

  static async getUnreadCount(userId: string): Promise<{ count: number }> {
    await connectDB();
    const count = await Notification.countDocuments({
      employeeId: new mongoose.Types.ObjectId(userId),
      isRead: false,
    });
    return { count };
  }
}
