import * as Sentry from '@sentry/node';
import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions/v2';
import type Stripe from 'stripe';
import { getWebhookSecret, stripe } from '../config/stripe';
import {
  downgradeToEssentials,
  getAccountIdFromStripeCustomer,
  updateAccountSubscription,
} from './helpers';

/**
 * Firebase HTTP Function to handle Stripe webhook events.
 * This endpoint processes subscription lifecycle events and updates Firestore accordingly.
 *
 * IMPORTANT: This endpoint must be configured in Stripe Dashboard as a webhook endpoint.
 * The webhook URL will be: https://us-central1-<project-id>.cloudfunctions.net/handleStripeWebhook
 *
 * Events handled:
 * - customer.subscription.created
 * - customer.subscription.updated
 * - customer.subscription.deleted
 * - invoice.payment_succeeded
 * - invoice.payment_failed
 */
export const handleStripeWebhook = functions.https.onRequest(async (request, response) => {
  return Sentry.startSpan(
    {
      name: 'handleStripeWebhook',
      op: 'function.https.request',
    },
    async () => {
      // Only accept POST requests
      if (request.method !== 'POST') {
        response.status(405).send('Method Not Allowed');
        return;
      }

      const sig = request.headers['stripe-signature'];

      if (!sig) {
        console.error('Missing Stripe signature header');
        response.status(400).send('Missing Stripe signature');
        return;
      }

      let event: Stripe.Event;

      try {
        // Verify webhook signature using the raw body
        const webhookSecret = getWebhookSecret();
        event = stripe.webhooks.constructEvent(request.rawBody, sig, webhookSecret);
      } catch (error) {
        console.error('Webhook signature verification failed:', error);
        Sentry.captureException(error);
        response
          .status(400)
          .send(`Webhook Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return;
      }

      // Log the event for debugging
      console.log(`Received webhook event: ${event.type}`, { eventId: event.id });

      try {
        // Route event to appropriate handler
        switch (event.type) {
          case 'customer.subscription.created':
            await handleSubscriptionCreated(event.data.object as Stripe.Subscription);
            break;

          case 'customer.subscription.updated':
            await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
            break;

          case 'customer.subscription.deleted':
            await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
            break;

          case 'invoice.payment_succeeded':
            await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
            break;

          case 'invoice.payment_failed':
            await handlePaymentFailed(event.data.object as Stripe.Invoice);
            break;

          default:
            console.log(`Unhandled event type: ${event.type}`);
        }

        // Acknowledge receipt of the event
        response.status(200).json({ received: true });
      } catch (error) {
        console.error('Error processing webhook event:', error);
        Sentry.captureException(error);
        // Still return 200 to prevent Stripe from retrying
        // (we've already logged the error to Sentry for investigation)
        response.status(200).json({ received: true, error: 'Processing failed but acknowledged' });
      }
    },
  );
});

/**
 * Handle customer.subscription.created event.
 * This is fired when a new subscription is created.
 */
async function handleSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
  console.log(`Processing subscription created: ${subscription.id}`);

  try {
    const accountId = await getAccountIdFromStripeCustomer(subscription.customer as string);
    await updateAccountSubscription(accountId, subscription);
    console.log(`Successfully processed subscription created for account ${accountId}`);
  } catch (error) {
    console.error('Error handling subscription created:', error);
    throw error;
  }
}

/**
 * Handle customer.subscription.updated event.
 * This is fired when a subscription is modified (e.g., plan change, status change).
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  console.log(`Processing subscription updated: ${subscription.id}`);

  try {
    const accountId = await getAccountIdFromStripeCustomer(subscription.customer as string);
    await updateAccountSubscription(accountId, subscription);
    console.log(`Successfully processed subscription updated for account ${accountId}`);
  } catch (error) {
    console.error('Error handling subscription updated:', error);
    throw error;
  }
}

/**
 * Handle customer.subscription.deleted event.
 * This is fired when a subscription is canceled or expires.
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  console.log(`Processing subscription deleted: ${subscription.id}`);

  try {
    const accountId = await getAccountIdFromStripeCustomer(subscription.customer as string);
    await downgradeToEssentials(accountId);
    console.log(`Successfully downgraded account ${accountId} to essentials`);
  } catch (error) {
    console.error('Error handling subscription deleted:', error);
    throw error;
  }
}

/**
 * Handle invoice.payment_succeeded event.
 * This is fired when a subscription payment succeeds (including renewals).
 */
async function handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  console.log(`Processing payment succeeded: ${invoice.id}`);

  // Only process if this invoice is for a subscription
  if (!(invoice as any).subscription) {
    console.log('Invoice is not for a subscription, skipping');
    return;
  }

  try {
    // Retrieve the subscription to get updated information
    const subscription = await stripe.subscriptions.retrieve((invoice as any).subscription as string);
    const accountId = await getAccountIdFromStripeCustomer(subscription.customer as string);

    // Update subscription with new period end date
    await updateAccountSubscription(accountId, subscription);

    // Clear any payment failure timestamp
    const db = admin.firestore();
    await db.collection('accounts').doc(accountId).update({
      lastPaymentFailedAt: null,
      updatedAt: admin.firestore.Timestamp.now(),
    });

    console.log(`Successfully processed payment succeeded for account ${accountId}`);
  } catch (error) {
    console.error('Error handling payment succeeded:', error);
    throw error;
  }
}

/**
 * Handle invoice.payment_failed event.
 * This is fired when a subscription payment fails.
 */
async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  console.log(`Processing payment failed: ${invoice.id}`);

  // Only process if this invoice is for a subscription
  if (!(invoice as any).subscription) {
    console.log('Invoice is not for a subscription, skipping');
    return;
  }

  try {
    const subscription = await stripe.subscriptions.retrieve((invoice as any).subscription as string);
    const accountId = await getAccountIdFromStripeCustomer(subscription.customer as string);

    // Update subscription status and record payment failure
    const db = admin.firestore();
    await db.collection('accounts').doc(accountId).update({
      stripeSubscriptionStatus: subscription.status,
      lastPaymentFailedAt: admin.firestore.Timestamp.now(),
      updatedAt: admin.firestore.Timestamp.now(),
    });

    console.log(`Recorded payment failure for account ${accountId}`);
    // Note: We don't immediately downgrade - Stripe will retry and eventually send subscription.deleted if all retries fail
  } catch (error) {
    console.error('Error handling payment failed:', error);
    throw error;
  }
}
