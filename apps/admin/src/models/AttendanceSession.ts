import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IGeoPoint {
  latitude: number;
  longitude: number;
  accuracy: number;
  distanceFromOffice: number;
}

export interface ICheckInData extends IGeoPoint {
  timestamp: Date;
  deviceFingerprint: string;
  nonce: string;
  isWithinGeoFence: boolean;
  address?: string | null;
  geocodingStatus?: string;
  geocodingProvider?: string | null;
}

export interface ICheckOutData {
  timestamp: Date;
  nonce: string;
  // Coordinates are REQUIRED at checkout for ordinary employees under an enabled
  // geofence (docs/84). Otherwise optional; when absent they are stored as 0 with
  // locationProvided=false and isWithinGeoFence=false.
  latitude: number;
  longitude: number;
  accuracy: number;
  distanceFromOffice: number;
  deviceFingerprint: string;
  isWithinGeoFence: boolean;
  locationProvided?: boolean;
}

export interface IAttendanceFlags {
  lowGpsAccuracy: boolean;
  outsideGeoFence: boolean;
  suspiciousTimestamp: boolean;
  possibleMockGps: boolean;
}

// 'midnight-rollover' is legacy (pre-docs/85 work-end crediting); new code
// writes 'missed-checkout' (24-hour rule, no fabricated checkout).
export type SystemCloseReason = 'midnight-rollover' | 'admin-force-close' | 'missed-checkout';

export interface IAttendanceSession extends Document {
  employeeId: mongoose.Types.ObjectId;
  attendanceDayId: mongoose.Types.ObjectId;
  dateString: string;

  checkIn: ICheckInData;
  checkOut: ICheckOutData | null;

  durationMinutes: number | null;
  isActive: boolean;
  closedBySystem: boolean;
  systemCloseReason?: SystemCloseReason;
  /** checkIn + 24 h — set when the session became a missed check-out. */
  missedCheckoutDeadline?: Date;
  missedCheckoutDetectedAt?: Date;

  flags: IAttendanceFlags;

  isRemote: boolean;
  remoteSource?: 'employeeOverride' | 'workAwayApproval';
  remoteApprovalId?: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const CheckInSchema = new Schema<ICheckInData>(
  {
    latitude:           { type: Number, required: true, min: -90,  max: 90  },
    longitude:          { type: Number, required: true, min: -180, max: 180 },
    accuracy:           { type: Number, required: true, min: 0 },
    distanceFromOffice: { type: Number, required: true, min: 0 },
    timestamp:          { type: Date,   required: true },
    deviceFingerprint:  { type: String, required: true },
    nonce:              { type: String, required: true },
    isWithinGeoFence:   { type: Boolean, required: true },
    address:            { type: String, default: null },
    geocodingStatus:    { type: String },
    geocodingProvider:  { type: String, default: null },
  },
  { _id: false },
);

const CheckOutSchema = new Schema<ICheckOutData>(
  {
    latitude:           { type: Number, required: true, default: 0 },
    longitude:          { type: Number, required: true, default: 0 },
    accuracy:           { type: Number, required: true, default: 0 },
    distanceFromOffice: { type: Number, required: true, default: 0 },
    timestamp:          { type: Date,   required: true },
    nonce:              { type: String, required: true },
    deviceFingerprint:  { type: String, required: true, default: '' },
    // Default false: a checkout without verified coordinates is never "inside".
    isWithinGeoFence:   { type: Boolean, required: true, default: false },
    // false when the client sent no coordinates (override / office-IP / system close).
    locationProvided:   { type: Boolean },
  },
  { _id: false },
);

const FlagsSchema = new Schema<IAttendanceFlags>(
  {
    lowGpsAccuracy:      { type: Boolean, required: true, default: false },
    outsideGeoFence:     { type: Boolean, required: true, default: false },
    suspiciousTimestamp: { type: Boolean, required: true, default: false },
    possibleMockGps:     { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const AttendanceSessionSchema = new Schema<IAttendanceSession>(
  {
    employeeId:      { type: Schema.Types.ObjectId, ref: 'User',          required: true },
    attendanceDayId: { type: Schema.Types.ObjectId, ref: 'AttendanceDay', required: true },
    dateString:      { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    checkIn:  { type: CheckInSchema, required: true },
    checkOut: { type: CheckOutSchema, default: null },

    durationMinutes:   { type: Number,  default: null, min: 0 },
    isActive:          { type: Boolean, required: true, default: true },
    closedBySystem:    { type: Boolean, required: true, default: false },
    systemCloseReason: { type: String,  enum: ['midnight-rollover', 'admin-force-close', 'missed-checkout'] },
    missedCheckoutDeadline:   { type: Date },
    missedCheckoutDetectedAt: { type: Date },

    flags: {
      type: FlagsSchema,
      required: true,
      default: () => ({ lowGpsAccuracy: false, outsideGeoFence: false, suspiciousTimestamp: false, possibleMockGps: false }),
    },

    isRemote:        { type: Boolean, required: true, default: false },
    remoteSource:    { type: String, enum: ['employeeOverride', 'workAwayApproval'] },
    remoteApprovalId: { type: Schema.Types.ObjectId, ref: 'Regularization' },
  },
  { timestamps: true },
);

// Partial unique index — at most one isActive: true per employee at DB level
AttendanceSessionSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { isActive: true }, name: 'unique_active_session_per_employee' },
);
AttendanceSessionSchema.index({ employeeId: 1, dateString: 1 });
AttendanceSessionSchema.index({ employeeId: 1, isActive: 1 });
AttendanceSessionSchema.index({ attendanceDayId: 1 });
// Missed-check-out reconciliation: active sessions ordered by check-in time.
AttendanceSessionSchema.index({ isActive: 1, 'checkIn.timestamp': 1 });

export const AttendanceSession: Model<IAttendanceSession> =
  (mongoose.models['AttendanceSession'] as Model<IAttendanceSession>) ??
  mongoose.model<IAttendanceSession>('AttendanceSession', AttendanceSessionSchema);
