import type { Response } from 'express';

export type ErrorCode =
  | 'validation_failed'
  | 'invalid_init_data'
  | 'expired_init_data'
  | 'not_active'
  | 'not_found'
  | 'already_added'
  | 'citizen_not_found'
  | 'forbidden'
  | 'internal_error';

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function errorBody(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  const body: ErrorEnvelope = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return body;
}

export function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): void {
  res.status(status).json(errorBody(code, message, details));
}
