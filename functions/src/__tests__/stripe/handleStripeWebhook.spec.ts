import type Stripe from 'stripe';

// Mock firebase-admin
jest.mock('firebase-admin', () => {
  return {
    firestore: jest.fn().mockReturnValue({
      collection: jest.fn(),
      Timestamp: {
        now: jest.fn().mockReturnValue({ toMillis: () => Date.now() }),
        fromMillis: jest.fn((ms) => ({ toMillis: () => ms })),
      },
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
    webhooks: {
      constructEvent: jest.fn(),
    },
    subscriptions: {
      retrieve: jest.fn(),
    },
  },
  getWebhookSecret: jest.fn().mockReturnValue('whsec_test_secret'),
}));

// Mock helper functions
jest.mock('../../stripe/helpers', () => ({
  updateAccountSubscription: jest.fn(),
  downgradeToEssentials: jest.fn(),
  getAccountIdFromStripeCustomer: jest.fn(),
}));

// Import after mocks
import * as admin from 'firebase-admin';
import { stripe } from '../../config/stripe';
import { handleStripeWebhook } from '../../stripe/handleStripeWebhook';
import {
  downgradeToEssentials,
  getAccountIdFromStripeCustomer,
  updateAccountSubscription,
} from '../../stripe/helpers';

describe('handleStripeWebhook', () => {
  const mockRequest = {
    method: 'POST',
    headers: {
      'stripe-signature': 'test_signature',
    },
    rawBody: Buffer.from('test_payload'),
  };

  const mockResponse = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };

  const mockSubscription: Partial<Stripe.Subscription> = {
    id: 'sub_123',
    customer: 'cus_123',
    status: 'active',
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days from now
  };

  const mockInvoice: Partial<Stripe.Invoice> = {
    id: 'in_123',
    subscription: 'sub_123',
    customer: 'cus_123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should reject non-POST requests', async () => {
    const getRequest = { ...mockRequest, method: 'GET' };

    await handleStripeWebhook(getRequest as never, mockResponse as never);

    expect(mockResponse.status).toHaveBeenCalledWith(405);
    expect(mockResponse.send).toHaveBeenCalledWith('Method Not Allowed');
  });

  it('should reject requests without Stripe signature', async () => {
    const noSigRequest = {
      ...mockRequest,
      headers: {},
    };

    await handleStripeWebhook(noSigRequest as never, mockResponse as never);

    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.send).toHaveBeenCalledWith('Missing Stripe signature');
  });

  it('should reject requests with invalid signature', async () => {
    (stripe.webhooks.constructEvent as jest.Mock).mockImplementation(() => {
      throw new Error('Invalid signature');
    });

    await handleStripeWebhook(mockRequest as never, mockResponse as never);

    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.send).toHaveBeenCalledWith('Webhook Error: Invalid signature');
  });

  it('should handle customer.subscription.created event', async () => {
    const event: Partial<Stripe.Event> = {
      id: 'evt_123',
      type: 'customer.subscription.created',
      data: {
        object: mockSubscription as Stripe.Subscription,
      },
    };

    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(event);
    (getAccountIdFromStripeCustomer as jest.Mock).mockResolvedValue('account123');
    (updateAccountSubscription as jest.Mock).mockResolvedValue(undefined);

    await handleStripeWebhook(mockRequest as never, mockResponse as never);

    expect(getAccountIdFromStripeCustomer).toHaveBeenCalledWith('cus_123');
    expect(updateAccountSubscription).toHaveBeenCalledWith('account123', mockSubscription);
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({ received: true });
  });

  it('should handle customer.subscription.updated event', async () => {
    const event: Partial<Stripe.Event> = {
      id: 'evt_123',
      type: 'customer.subscription.updated',
      data: {
        object: mockSubscription as Stripe.Subscription,
      },
    };

    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(event);
    (getAccountIdFromStripeCustomer as jest.Mock).mockResolvedValue('account123');
    (updateAccountSubscription as jest.Mock).mockResolvedValue(undefined);

    await handleStripeWebhook(mockRequest as never, mockResponse as never);

    expect(getAccountIdFromStripeCustomer).toHaveBeenCalledWith('cus_123');
    expect(updateAccountSubscription).toHaveBeenCalledWith('account123', mockSubscription);
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({ received: true });
  });

  it('should handle customer.subscription.deleted event', async () => {
    const event: Partial<Stripe.Event> = {
      id: 'evt_123',
      type: 'customer.subscription.deleted',
      data: {
        object: mockSubscription as Stripe.Subscription,
      },
    };

    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(event);
    (getAccountIdFromStripeCustomer as jest.Mock).mockResolvedValue('account123');
    (downgradeToEssentials as jest.Mock).mockResolvedValue(undefined);

    await handleStripeWebhook(mockRequest as never, mockResponse as never);

    expect(getAccountIdFromStripeCustomer).toHaveBeenCalledWith('cus_123');
    expect(downgradeToEssentials).toHaveBeenCalledWith('account123');
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({ received: true });
  });

  it('should handle invoice.payment_succeeded event', async () => {
    const event: Partial<Stripe.Event> = {
      id: 'evt_123',
      type: 'invoice.payment_succeeded',
      data: {
        object: mockInvoice as Stripe.Invoice,
      },
    };

    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(event);
    (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue(mockSubscription);
    (getAccountIdFromStripeCustomer as jest.Mock).mockResolvedValue('account123');
    (updateAccountSubscription as jest.Mock).mockResolvedValue(undefined);

    const mockUpdate = jest.fn().mockResolvedValue(undefined);
    const mockDoc = jest.fn().mockReturnValue({ update: mockUpdate });
    const mockCollection = jest.fn().mockReturnValue({ doc: mockDoc });
    (admin.firestore as jest.Mock).mockReturnValue({ collection: mockCollection });

    await handleStripeWebhook(mockRequest as never, mockResponse as never);

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123');
    expect(getAccountIdFromStripeCustomer).toHaveBeenCalledWith('cus_123');
    expect(updateAccountSubscription).toHaveBeenCalledWith('account123', mockSubscription);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        lastPaymentFailedAt: null,
      }),
    );
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({ received: true });
  });

  it('should skip invoice.payment_succeeded for non-subscription invoices', async () => {
    const nonSubscriptionInvoice: Partial<Stripe.Invoice> = {
      id: 'in_123',
      subscription: null,
      customer: 'cus_123',
    };

    const event: Partial<Stripe.Event> = {
      id: 'evt_123',
      type: 'invoice.payment_succeeded',
      data: {
        object: nonSubscriptionInvoice as Stripe.Invoice,
      },
    };

    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(event);

    await handleStripeWebhook(mockRequest as never, mockResponse as never);

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(updateAccountSubscription).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(200);
  });

  it('should handle invoice.payment_failed event', async () => {
    const event: Partial<Stripe.Event> = {
      id: 'evt_123',
      type: 'invoice.payment_failed',
      data: {
        object: mockInvoice as Stripe.Invoice,
      },
    };

    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(event);
    (stripe.subscriptions.retrieve as jest.Mock).mockResolvedValue(mockSubscription);
    (getAccountIdFromStripeCustomer as jest.Mock).mockResolvedValue('account123');

    const mockUpdate = jest.fn().mockResolvedValue(undefined);
    const mockDoc = jest.fn().mockReturnValue({ update: mockUpdate });
    const mockCollection = jest.fn().mockReturnValue({ doc: mockDoc });
    (admin.firestore as jest.Mock).mockReturnValue({ collection: mockCollection });

    await handleStripeWebhook(mockRequest as never, mockResponse as never);

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123');
    expect(getAccountIdFromStripeCustomer).toHaveBeenCalledWith('cus_123');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionStatus: 'active',
      }),
    );
    expect(mockResponse.status).toHaveBeenCalledWith(200);
  });

  it('should skip invoice.payment_failed for non-subscription invoices', async () => {
    const nonSubscriptionInvoice: Partial<Stripe.Invoice> = {
      id: 'in_123',
      subscription: null,
      customer: 'cus_123',
    };

    const event: Partial<Stripe.Event> = {
      id: 'evt_123',
      type: 'invoice.payment_failed',
      data: {
        object: nonSubscriptionInvoice as Stripe.Invoice,
      },
    };

    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(event);

    await handleStripeWebhook(mockRequest as never, mockResponse as never);

    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(200);
  });

  it('should handle unhandled event types gracefully', async () => {
    const event: Partial<Stripe.Event> = {
      id: 'evt_123',
      type: 'customer.created',
      data: {
        object: {} as never,
      },
    };

    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(event);

    await handleStripeWebhook(mockRequest as never, mockResponse as never);

    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({ received: true });
  });

  it('should acknowledge webhook even when processing fails', async () => {
    const event: Partial<Stripe.Event> = {
      id: 'evt_123',
      type: 'customer.subscription.created',
      data: {
        object: mockSubscription as Stripe.Subscription,
      },
    };

    (stripe.webhooks.constructEvent as jest.Mock).mockReturnValue(event);
    (getAccountIdFromStripeCustomer as jest.Mock).mockRejectedValue(new Error('Database error'));

    const Sentry = require('@sentry/node');

    await handleStripeWebhook(mockRequest as never, mockResponse as never);

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(200);
    expect(mockResponse.json).toHaveBeenCalledWith({
      received: true,
      error: 'Processing failed but acknowledged',
    });
  });
});
