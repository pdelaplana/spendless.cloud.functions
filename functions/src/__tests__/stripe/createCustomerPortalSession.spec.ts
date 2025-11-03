import type Stripe from 'stripe';

// Mock firebase-admin
jest.mock('firebase-admin', () => {
  return {
    firestore: jest.fn().mockReturnValue({
      collection: jest.fn(),
    }),
  };
});

// Mock Sentry
jest.mock('@sentry/node', () => ({
  default: {
    startSpan: jest.fn().mockImplementation((_options, fn) => fn()),
    captureException: jest.fn(),
  },
  startSpan: jest.fn().mockImplementation((_options, fn) => fn()),
  captureException: jest.fn(),
}));

// Mock Stripe configuration
jest.mock('../../config/stripe', () => ({
  stripe: {
    billingPortal: {
      sessions: {
        create: jest.fn(),
      },
    },
  },
}));

// Mock helper functions
jest.mock('../../stripe/helpers', () => ({
  getAccountIdByUserId: jest.fn(),
}));

// Import after mocks
import * as admin from 'firebase-admin';
import { stripe } from '../../config/stripe';
import { createCustomerPortalSession } from '../../stripe/createCustomerPortalSession';
import { getAccountIdByUserId } from '../../stripe/helpers';

describe('createCustomerPortalSession', () => {
  const mockAuth = {
    uid: 'user123',
    token: {
      email: 'test@example.com',
    },
  };

  const mockPortalSession: Partial<Stripe.BillingPortal.Session> = {
    id: 'bps_123',
    url: 'https://billing.stripe.com/session/test_123',
  };

  const mockAccountData = {
    id: 'account123',
    userId: 'user123',
    stripeCustomerId: 'cus_123',
    subscriptionTier: 'premium',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FRONTEND_URL = 'http://localhost:8100';
  });

  it('should create customer portal session successfully', async () => {
    // Setup mocks
    (getAccountIdByUserId as jest.Mock).mockResolvedValue('account123');

    const mockGet = jest.fn().mockResolvedValue({
      exists: true,
      data: () => mockAccountData,
    });

    const mockDoc = jest.fn().mockReturnValue({ get: mockGet });
    const mockCollection = jest.fn().mockReturnValue({ doc: mockDoc });
    (admin.firestore as jest.Mock).mockReturnValue({ collection: mockCollection });

    (stripe.billingPortal.sessions.create as jest.Mock).mockResolvedValue(mockPortalSession);

    // Call function
    const result = await createCustomerPortalSession({
      auth: mockAuth,
      data: {},
    } as never);

    // Assertions
    expect(result).toEqual({
      url: 'https://billing.stripe.com/session/test_123',
    });

    expect(getAccountIdByUserId).toHaveBeenCalledWith('user123');
    expect(mockCollection).toHaveBeenCalledWith('accounts');
    expect(mockDoc).toHaveBeenCalledWith('account123');
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: 'http://localhost:8100/settings',
    });
  });

  it('should use custom return URL when provided', async () => {
    // Setup mocks
    (getAccountIdByUserId as jest.Mock).mockResolvedValue('account123');

    const mockGet = jest.fn().mockResolvedValue({
      exists: true,
      data: () => mockAccountData,
    });

    const mockDoc = jest.fn().mockReturnValue({ get: mockGet });
    const mockCollection = jest.fn().mockReturnValue({ doc: mockDoc });
    (admin.firestore as jest.Mock).mockReturnValue({ collection: mockCollection });

    (stripe.billingPortal.sessions.create as jest.Mock).mockResolvedValue(mockPortalSession);

    // Call function with custom return URL
    await createCustomerPortalSession({
      auth: mockAuth,
      data: { returnUrl: 'https://example.com/dashboard' },
    } as never);

    // Verify custom return URL was used
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: 'https://example.com/dashboard',
    });
  });

  it('should throw unauthenticated error when user is not authenticated', async () => {
    // Call function without auth
    await expect(
      createCustomerPortalSession({
        auth: null,
        data: {},
      } as never),
    ).rejects.toThrow('User must be authenticated to access the customer portal.');
  });

  it('should throw invalid-argument error when user ID is missing', async () => {
    // Call function without uid
    await expect(
      createCustomerPortalSession({
        auth: { token: { email: 'test@example.com' } },
        data: {},
      } as never),
    ).rejects.toThrow('User ID is required.');
  });

  it('should throw not-found error when account does not exist', async () => {
    // Setup mocks
    (getAccountIdByUserId as jest.Mock).mockResolvedValue('account123');

    const mockGet = jest.fn().mockResolvedValue({
      exists: false,
    });

    const mockDoc = jest.fn().mockReturnValue({ get: mockGet });
    const mockCollection = jest.fn().mockReturnValue({ doc: mockDoc });
    (admin.firestore as jest.Mock).mockReturnValue({ collection: mockCollection });

    // Call function
    await expect(
      createCustomerPortalSession({
        auth: mockAuth,
        data: {},
      } as never),
    ).rejects.toThrow('Account not found.');
  });

  it('should throw failed-precondition error when account has no Stripe customer ID', async () => {
    // Setup mocks
    (getAccountIdByUserId as jest.Mock).mockResolvedValue('account123');

    const mockGet = jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({
        id: 'account123',
        userId: 'user123',
        stripeCustomerId: null,
      }),
    });

    const mockDoc = jest.fn().mockReturnValue({ get: mockGet });
    const mockCollection = jest.fn().mockReturnValue({ doc: mockDoc });
    (admin.firestore as jest.Mock).mockReturnValue({ collection: mockCollection });

    // Call function
    await expect(
      createCustomerPortalSession({
        auth: mockAuth,
        data: {},
      } as never),
    ).rejects.toThrow('No Stripe customer found. Please create a subscription first.');
  });

  it('should throw internal error when portal session creation fails', async () => {
    // Setup mocks
    (getAccountIdByUserId as jest.Mock).mockResolvedValue('account123');

    const mockGet = jest.fn().mockResolvedValue({
      exists: true,
      data: () => mockAccountData,
    });

    const mockDoc = jest.fn().mockReturnValue({ get: mockGet });
    const mockCollection = jest.fn().mockReturnValue({ doc: mockDoc });
    (admin.firestore as jest.Mock).mockReturnValue({ collection: mockCollection });

    (stripe.billingPortal.sessions.create as jest.Mock).mockResolvedValue({
      id: 'bps_123',
      url: null,
    });

    // Call function
    await expect(
      createCustomerPortalSession({
        auth: mockAuth,
        data: {},
      } as never),
    ).rejects.toThrow('Failed to create customer portal session.');
  });

  it('should throw internal error and log to Sentry when unexpected error occurs', async () => {
    // Setup mocks
    (getAccountIdByUserId as jest.Mock).mockRejectedValue(new Error('Database error'));

    const Sentry = require('@sentry/node');

    // Call function
    await expect(
      createCustomerPortalSession({
        auth: mockAuth,
        data: {},
      } as never),
    ).rejects.toThrow('An error occurred while creating the customer portal session.');

    // Verify error was logged to Sentry
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it('should use default return URL when returnUrl is not provided', async () => {
    // Setup mocks
    (getAccountIdByUserId as jest.Mock).mockResolvedValue('account123');

    const mockGet = jest.fn().mockResolvedValue({
      exists: true,
      data: () => mockAccountData,
    });

    const mockDoc = jest.fn().mockReturnValue({ get: mockGet });
    const mockCollection = jest.fn().mockReturnValue({ doc: mockDoc });
    (admin.firestore as jest.Mock).mockReturnValue({ collection: mockCollection });

    (stripe.billingPortal.sessions.create as jest.Mock).mockResolvedValue(mockPortalSession);

    // Call function with empty data
    await createCustomerPortalSession({
      auth: mockAuth,
      data: {},
    } as never);

    // Verify default return URL was used
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        return_url: 'http://localhost:8100/settings',
      }),
    );
  });
});
