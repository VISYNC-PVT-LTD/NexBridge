/**
 * Real Brevo transport payload, exercised against a mocked fetch.
 * (Everywhere else the module is globally mocked by jest.setup.ts.)
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

type BrevoModule = typeof import('@lib/email/brevo');
const { sendEmail, sendTransactionalEmail, EmailProviderError } =
  jest.requireActual<BrevoModule>('@lib/email/brevo');

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ messageId: 'm1' }), text: async () => '' }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('Brevo transport', () => {
  it('sendEmail POSTs recipient and subject to the Brevo SMTP endpoint', async () => {
    await sendEmail({ to: { email: 'emp@test.com', name: 'John Doe' }, subject: 'Leave Approved', htmlContent: '<p>x</p>' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.brevo.com/v3/smtp/email',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('emp@test.com') }),
    );
    const init = fetchMock.mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body).subject).toBe('Leave Approved');
  });

  it('sendEmail throws when the provider rejects (callers decide whether to swallow)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'unauthorized', json: async () => ({}) } as never);
    await expect(
      sendEmail({ to: { email: 'emp@test.com' }, subject: 's', htmlContent: 'h' }),
    ).rejects.toThrow(/Brevo error 401/);
  });

  it('sendTransactionalEmail does not echo the provider response body in errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'secret-recipient-list', json: async () => ({}) } as never);
    const err = await sendTransactionalEmail({ to: ['a@b.invalid'], subject: 's', htmlContent: 'h' }).catch((e) => e);
    expect(err).toBeInstanceOf(EmailProviderError);
    expect(String(err.message)).not.toContain('secret-recipient-list');
  });
});
