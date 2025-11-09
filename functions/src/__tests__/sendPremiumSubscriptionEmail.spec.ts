import * as admin from 'firebase-admin';
import type { UserRecord } from 'firebase-admin/auth';
import { sendEmailNotification } from '../helpers/sendEmail';

// Mock firebase-admin (same pattern as sendWelcomeEmail.spec.ts)
jest.mock('firebase-admin', () => {
  return {
    firestore: jest.fn().mockReturnValue({
      collection: jest.fn(),
    }),
    storage: jest.fn().mockReturnValue({
      bucket: jest.fn(),
    }),
    auth: jest.fn().mockReturnValue({
      getUser: jest.fn(),
    }),
  };
});

// Mock email sending
jest.mock('../helpers/sendEmail', () => ({
  sendEmailNotification: jest.fn().mockResolvedValue({}),
}));

// Mock Sentry
jest.mock('@sentry/node', () => ({
  default: {
    startSpan: jest.fn().mockImplementation((_options, fn) => fn()),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
  },
  startSpan: jest.fn().mockImplementation((_options, fn) => fn()),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Mock fs for template loading
jest.mock('node:fs', () => ({
  readFileSync: jest.fn().mockReturnValue(`
# Premium Subscription - Thank You Email

## Subject Line
Thanks for upgrading to Premium, {firstName}!

## Email Body

Hey {firstName},

Thank you so much for upgrading to Spendless Premium!

Your support means the world to me and directly helps keep Spendless growing and improving.

Cheers,
{founderName}
Founder, Spendless

---

## Email Footer

© {currentYear} Spendless. All rights reserved.
  `),
}));

// Import after mocks are set up
import { sendPremiumSubscriptionEmail } from '../sendPremiumSubscriptionEmail';

describe('sendPremiumSubscriptionEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should send premium subscription email successfully with displayName', async () => {
    // Mock user with displayName
    const mockUserRecord: Partial<UserRecord> = {
      uid: 'user123',
      email: 'john.doe@example.com',
      displayName: 'John Doe',
    };

    (admin.auth().getUser as jest.Mock).mockResolvedValue(mockUserRecord);

    // Execute function
    await sendPremiumSubscriptionEmail('user123');

    // Verify email was sent
    expect(sendEmailNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Spendless" <patrick@getspendless.com>',
        to: 'john.doe@example.com',
        subject: expect.stringContaining('John'),
        html: expect.any(String),
      }),
    );

    // Verify the subject contains the first name
    const emailCall = (sendEmailNotification as jest.Mock).mock.calls[0][0];
    expect(emailCall.subject).toContain('John');
    expect(emailCall.subject).not.toContain('{firstName}');

    // Verify the body contains replaced variables
    expect(emailCall.html).toContain('John');
    expect(emailCall.html).toContain('Patrick');
  });

  it('should use "there" as fallback when displayName is undefined', async () => {
    // Mock user without displayName
    const mockUserRecord: Partial<UserRecord> = {
      uid: 'user123',
      email: 'jane@example.com',
      displayName: undefined,
    };

    (admin.auth().getUser as jest.Mock).mockResolvedValue(mockUserRecord);

    // Execute function
    await sendPremiumSubscriptionEmail('user123');

    // Verify email was sent with "there" as firstName
    expect(sendEmailNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'jane@example.com',
        subject: expect.stringContaining('there'),
      }),
    );

    const emailCall = (sendEmailNotification as jest.Mock).mock.calls[0][0];
    expect(emailCall.html).toContain('there');
  });

  it('should use "there" as fallback when displayName is empty string', async () => {
    // Mock user with empty displayName
    const mockUserRecord: Partial<UserRecord> = {
      uid: 'user123',
      email: 'test@example.com',
      displayName: '',
    };

    (admin.auth().getUser as jest.Mock).mockResolvedValue(mockUserRecord);

    // Execute function
    await sendPremiumSubscriptionEmail('user123');

    // Verify email was sent with "there" as firstName
    const emailCall = (sendEmailNotification as jest.Mock).mock.calls[0][0];
    expect(emailCall.subject).toContain('there');
    expect(emailCall.html).toContain('there');
  });

  it('should extract first name correctly from multi-word displayName', async () => {
    // Mock user with multi-word displayName
    const mockUserRecord: Partial<UserRecord> = {
      uid: 'user123',
      email: 'test@example.com',
      displayName: 'Mary Jane Watson',
    };

    (admin.auth().getUser as jest.Mock).mockResolvedValue(mockUserRecord);

    // Execute function
    await sendPremiumSubscriptionEmail('user123');

    // Verify only first name is used
    const emailCall = (sendEmailNotification as jest.Mock).mock.calls[0][0];
    expect(emailCall.subject).toContain('Mary');
    expect(emailCall.subject).not.toContain('Jane');
    expect(emailCall.subject).not.toContain('Watson');
  });

  it('should not send email when user has no email address', async () => {
    // Mock user without email
    const mockUserRecord: Partial<UserRecord> = {
      uid: 'user123',
      email: undefined,
      displayName: 'John Doe',
    };

    (admin.auth().getUser as jest.Mock).mockResolvedValue(mockUserRecord);

    // Execute function
    await sendPremiumSubscriptionEmail('user123');

    // Verify email was NOT sent
    expect(sendEmailNotification).not.toHaveBeenCalled();
  });

  it('should handle Firebase Auth user not found error gracefully', async () => {
    // Mock getUser to throw error
    const authError = new Error('User not found');
    (admin.auth().getUser as jest.Mock).mockRejectedValue(authError);

    // Execute function - should not throw
    await expect(sendPremiumSubscriptionEmail('user123')).resolves.not.toThrow();

    // Verify email was NOT sent
    expect(sendEmailNotification).not.toHaveBeenCalled();
  });

  it('should handle email sending failure gracefully', async () => {
    // Mock user data
    const mockUserRecord: Partial<UserRecord> = {
      uid: 'user123',
      email: 'john@example.com',
      displayName: 'John Doe',
    };

    (admin.auth().getUser as jest.Mock).mockResolvedValue(mockUserRecord);

    // Mock sendEmailNotification to fail
    const emailError = new Error('Mailgun API error');
    (sendEmailNotification as jest.Mock).mockRejectedValue(emailError);

    // Execute function - should not throw (graceful error handling)
    await expect(sendPremiumSubscriptionEmail('user123')).resolves.not.toThrow();
  });

  it('should replace all template variables correctly', async () => {
    // Mock user data
    const mockUserRecord: Partial<UserRecord> = {
      uid: 'user123',
      email: 'test@example.com',
      displayName: 'Alice',
    };

    (admin.auth().getUser as jest.Mock).mockResolvedValue(mockUserRecord);

    // Execute function
    await sendPremiumSubscriptionEmail('user123');

    // Get the email that was sent
    const emailCall = (sendEmailNotification as jest.Mock).mock.calls[0][0];

    // Verify all variables were replaced
    expect(emailCall.html).toContain('Alice');
    expect(emailCall.html).toContain('Patrick');

    // Verify no placeholders remain
    expect(emailCall.html).not.toContain('{firstName}');
    expect(emailCall.html).not.toContain('{founderName}');
  });

  it('should convert markdown to HTML', async () => {
    // Mock user data
    const mockUserRecord: Partial<UserRecord> = {
      uid: 'user123',
      email: 'test@example.com',
      displayName: 'Bob',
    };

    (admin.auth().getUser as jest.Mock).mockResolvedValue(mockUserRecord);

    // Execute function
    await sendPremiumSubscriptionEmail('user123');

    // Get the email that was sent
    const emailCall = (sendEmailNotification as jest.Mock).mock.calls[0][0];

    // Verify HTML tags are present (email has paragraphs and line breaks)
    expect(emailCall.html).toContain('<p>');
    expect(emailCall.html).toContain('<br>');
  });
});
