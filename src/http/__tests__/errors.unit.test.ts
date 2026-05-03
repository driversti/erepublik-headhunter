import { describe, expect, it, vi } from 'vitest';
import { errorBody, sendError } from '../errors.js';

describe('errorBody', () => {
  it('returns an envelope without details when none supplied', () => {
    expect(errorBody('not_found', 'gone')).toEqual({
      error: { code: 'not_found', message: 'gone' },
    });
  });

  it('includes details when supplied', () => {
    expect(errorBody('not_active', 'no', { status: 'pending' })).toEqual({
      error: { code: 'not_active', message: 'no', details: { status: 'pending' } },
    });
  });
});

describe('sendError', () => {
  it('sets status and sends the envelope', () => {
    const json = vi.fn().mockReturnThis();
    const status = vi.fn().mockReturnValue({ json });
    sendError({ status } as never, 401, 'invalid_init_data', 'bad');
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'invalid_init_data', message: 'bad' },
    });
  });

  it('forwards details into the body', () => {
    const json = vi.fn().mockReturnThis();
    const status = vi.fn().mockReturnValue({ json });
    sendError({ status } as never, 403, 'not_active', 'no', { status: 'revoked' });
    expect(json).toHaveBeenCalledWith({
      error: { code: 'not_active', message: 'no', details: { status: 'revoked' } },
    });
  });
});
