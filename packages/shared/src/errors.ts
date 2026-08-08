/**
 * Stable, machine-readable error codes.
 *
 * The mobile app switches on `code`, never on the human message — that lets us
 * reword copy without shipping an app update, and lets the client localise.
 */
export const ErrorCode = {
  // 400
  BadRequest: 'bad_request',
  ValidationFailed: 'validation_failed',
  UnsupportedMediaType: 'unsupported_media_type',
  PayloadTooLarge: 'payload_too_large',

  // 401 / 403
  Unauthenticated: 'unauthenticated',
  TokenExpired: 'token_expired',
  TokenRevoked: 'token_revoked',
  Forbidden: 'forbidden',
  MissingPermission: 'missing_permission',
  Blocked: 'blocked',
  PrivacyRestricted: 'privacy_restricted',
  AccountSuspended: 'account_suspended',

  // 404 / 409
  NotFound: 'not_found',
  Conflict: 'conflict',
  AlreadyExists: 'already_exists',
  NotAMember: 'not_a_member',
  AlreadyAMember: 'already_a_member',

  // 422
  Unprocessable: 'unprocessable',
  EditWindowExpired: 'edit_window_expired',
  MessageDeleted: 'message_deleted',
  CallAlreadyEnded: 'call_already_ended',
  CallFull: 'call_full',

  // 429
  RateLimited: 'rate_limited',
  SlowMode: 'slow_mode',

  // 5xx
  Internal: 'internal_error',
  Unavailable: 'service_unavailable',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  error: {
    code: ErrorCodeValue;
    message: string;
    /** Field-level detail for `validation_failed`. */
    details?: unknown;
    /** Seconds until the caller may retry — set on 429. */
    retryAfter?: number;
  };
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCodeValue;
  readonly details?: unknown;
  readonly retryAfter?: number;

  constructor(
    status: number,
    code: ErrorCodeValue,
    message: string,
    opts: { details?: unknown; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = opts.details;
    this.retryAfter = opts.retryAfter;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
      },
    };
  }
}

export const badRequest = (m = 'Bad request', details?: unknown) =>
  new AppError(400, ErrorCode.BadRequest, m, { details });
export const unauthenticated = (m = 'Authentication required') =>
  new AppError(401, ErrorCode.Unauthenticated, m);
export const forbidden = (m = 'You do not have access to this resource') =>
  new AppError(403, ErrorCode.Forbidden, m);
export const missingPermission = (permission: string) =>
  new AppError(403, ErrorCode.MissingPermission, `Missing permission: ${permission}`, {
    details: { permission },
  });
export const notFound = (what = 'Resource') => new AppError(404, ErrorCode.NotFound, `${what} not found`);
export const conflict = (m = 'Conflict', code: ErrorCodeValue = ErrorCode.Conflict) =>
  new AppError(409, code, m);
export const unprocessable = (m: string, code: ErrorCodeValue = ErrorCode.Unprocessable) =>
  new AppError(422, code, m);
export const rateLimited = (retryAfter: number, m = 'Too many requests') =>
  new AppError(429, ErrorCode.RateLimited, m, { retryAfter });
