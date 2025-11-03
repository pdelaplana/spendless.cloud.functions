import type { Timestamp } from 'firebase-admin/firestore';

export type JobType = 'exportData' | 'deleteAccount' | 'anotherJobType' | 'anotherJobType2';

export type Job = {
  userId: string;
  userEmail: string;
  jobType: JobType;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  priority: number;
  createdAt: Timestamp;
  completedAt: Timestamp | null;
  errors: string[];
  attempts: number;
};

// Stripe-related types

export type SubscriptionTier = 'essentials' | 'premium';

export type StripeSubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'past_due'
  | 'trialing'
  | 'unpaid';

export interface Account {
  id: string;
  userId: string;
  name: string;
  currency: string;
  subscriptionTier: SubscriptionTier;
  expiresAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  // Stripe-related fields
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeSubscriptionStatus?: StripeSubscriptionStatus;
  lastPaymentFailedAt?: Timestamp | null;
}

// Stripe function input/output types

export interface CreateCheckoutSessionRequest {
  priceId: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface CreateCheckoutSessionResponse {
  sessionId: string;
  url: string;
}

export interface CreateCustomerPortalSessionRequest {
  returnUrl?: string;
}

export interface CreateCustomerPortalSessionResponse {
  url: string;
}

// Stripe webhook event types
export type StripeWebhookEventType =
  | 'customer.subscription.created'
  | 'customer.subscription.updated'
  | 'customer.subscription.deleted'
  | 'invoice.payment_succeeded'
  | 'invoice.payment_failed';
