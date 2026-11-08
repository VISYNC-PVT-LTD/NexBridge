import mongoose, { Document, Model, Schema } from 'mongoose';

export type AttendanceDayStatus =
  | 'present'
  | 'absent'
  | 'half-day'
  | 'leave'
  | 'holiday'
  | 'weekend'
  | 'lwp'
  | 'not-applicable';

export interface IAttendanceDay extends Document {
  employeeId: mongoose.Types.ObjectId;
  date: Date;
  dateString: string;
  year: number;
  month: number;

  status: AttendanceDayStatus;
  totalMinutes: number;
  requiredMinutes: number;
  overtimeMinutes: number;

  // Late arrival tracking (added per BR-002 remediation)
  isLateArrival: boolean;
  lateByMinutes: number;
  isHalfDayCapped: boolean;

  leaveRequestId?: mongoose.Types.ObjectId;
  leaveType?: 'paidLeave' | 'sickLeave' | 'casualLeave' | 'lwp';
  leaveDuration?: 'full' | 'half';
  leaveHalfDayPeriod?: 'morning' | 'afternoon';

  regularizationRequestId?: mongoose.Types.ObjectId;
  isRegularized: boolean;
  /** True while a 24-hour missed check-out on this day awaits regularization/leave. */
  hasUnresolvedMissedCheckout?: boolean;
  /** The session that missed its check-out (kept for audit even after resolution). */
  missedCheckoutSessionId?: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const AttendanceDaySchema = new Schema<IAttendanceDay>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date:       { type: Date,   required: true },
    dateString: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    year:       { type: Number, required: true },
    month:      { type: Number, required: true, min: 1, max: 12 },

    status:          { type: String, enum: ['present','absent','half-day','leave','holiday','weekend','lwp','not-applicable'], required: true, default: 'absent' },
    totalMinutes:    { type: Number, required: true, default: 0, min: 0 },
    requiredMinutes: { type: Number, required: true, min: 0 },
    overtimeMinutes: { type: Number, required: true, default: 0, min: 0 },

    isLateArrival:  { type: Boolean, required: true, default: false },
    lateByMinutes:  { type: Number,  required: true, default: 0, min: 0 },
    isHalfDayCapped:{ type: Boolean, required: true, default: false },

    leaveRequestId:          { type: Schema.Types.ObjectId, ref: 'LeaveRequest' },
    leaveType:               { type: String, enum: ['paidLeave','sickLeave','casualLeave','lwp'] },
    leaveDuration:           { type: String, enum: ['full','half'] },
    leaveHalfDayPeriod:      { type: String, enum: ['morning','afternoon'] },

    regularizationRequestId: { type: Schema.Types.ObjectId, ref: 'RegularizationRequest' },
    isRegularized:           { type: Boolean, required: true, default: false },
    hasUnresolvedMissedCheckout: { type: Boolean, default: false },
    missedCheckoutSessionId:     { type: Schema.Types.ObjectId, ref: 'AttendanceSession' },
  },
  { timestamps: true },
);

AttendanceDaySchema.index({ employeeId: 1, dateString: 1 }, { unique: true });
AttendanceDaySchema.index({ employeeId: 1, status: 1 });
AttendanceDaySchema.index({ employeeId: 1, year: 1, month: 1 });
AttendanceDaySchema.index({ dateString: 1 });
AttendanceDaySchema.index({ employeeId: 1, hasUnresolvedMissedCheckout: 1, dateString: -1 });

export const AttendanceDay: Model<IAttendanceDay> =
  (mongoose.models['AttendanceDay'] as Model<IAttendanceDay>) ??
  mongoose.model<IAttendanceDay>('AttendanceDay', AttendanceDaySchema);
