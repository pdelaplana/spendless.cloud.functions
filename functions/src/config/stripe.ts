import * as functions from 'firebase-functions';
import Stripe from 'stripe';

/**
 * Initialize Stripe SDK with the secret key from environment variables.
 *
 * For local development: Uses STRIPE_SECRET_KEY from .env file
 * For production: Uses stripe.secret_key from Firebase Functions config
 */
const getStripeSecretKey = (): string => {
  // Try environment variable first (local development)
  if (process.env.STRIPE_SECRET_KEY) {
    return process.env.STRIPE_SECRET_KEY;
  }

  // Fall back to Firebase Functions config (production)
  const config = functions.config();
  if (config.stripe?.secret_key) {
    return config.stripe.secret_key;
  }

  throw new Error(
    'Stripe secret key not configured. Set STRIPE_SECRET_KEY environment variable or configure Firebase Functions config.',
  );
};

/**
 * Stripe client instance configured with the API key.
 * Uses the latest API version and includes app info for debugging.
 */
export const stripe = new Stripe(getStripeSecretKey(), {
  apiVersion: '2025-02-24.acacia',
  appInfo: {
    name: 'Spendless Cloud Functions',
    version: '1.0.0',
  },
});

/**
 * Get the Stripe webhook secret for signature verification.
 */
export const getWebhookSecret = (): string => {
  // Try environment variable first (local development)
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    return process.env.STRIPE_WEBHOOK_SECRET;
  }

  // Fall back to Firebase Functions config (production)
  const config = functions.config();
  if (config.stripe?.webhook_secret) {
    return config.stripe.webhook_secret;
  }

  throw new Error(
    'Stripe webhook secret not configured. Set STRIPE_WEBHOOK_SECRET environment variable or configure Firebase Functions config.',
  );
};

/**
 * Get the monthly subscription price ID.
 */
export const getMonthlyPriceId = (): string => {
  // Try environment variable first (local development)
  if (process.env.STRIPE_PRICE_ID_MONTHLY) {
    return process.env.STRIPE_PRICE_ID_MONTHLY;
  }

  // Fall back to Firebase Functions config (production)
  const config = functions.config();
  if (config.stripe?.price_id_monthly) {
    return config.stripe.price_id_monthly;
  }

  throw new Error(
    'Stripe monthly price ID not configured. Set STRIPE_PRICE_ID_MONTHLY environment variable or configure Firebase Functions config.',
  );
};

/**
 * Get the annual subscription price ID.
 */
export const getAnnualPriceId = (): string => {
  // Try environment variable first (local development)
  if (process.env.STRIPE_PRICE_ID_ANNUAL) {
    return process.env.STRIPE_PRICE_ID_ANNUAL;
  }

  // Fall back to Firebase Functions config (production)
  const config = functions.config();
  if (config.stripe?.price_id_annual) {
    return config.stripe.price_id_annual;
  }

  throw new Error(
    'Stripe annual price ID not configured. Set STRIPE_PRICE_ID_ANNUAL environment variable or configure Firebase Functions config.',
  );
};

/**
 * Validate if a price ID is one of the allowed subscription price IDs.
 */
export const isValidPriceId = (priceId: string): boolean => {
  try {
    const monthlyPriceId = getMonthlyPriceId();
    const annualPriceId = getAnnualPriceId();
    return priceId === monthlyPriceId || priceId === annualPriceId;
  } catch {
    return false;
  }
};
