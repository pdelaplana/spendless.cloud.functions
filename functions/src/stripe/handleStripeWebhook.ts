import * as Sentry from '@sentry/node';
import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions/v2';
import type Stripe from 'stripe';
import { getWebhookSecret, stripe, stripeSecretKey, stripeWebhookSecret } from '../config/stripe';
import type { Account } from '../types';

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
export const handleStripeWebhook = functions.https.onRequest(
  {
    secrets: [stripeSecretKey, stripeWebhookSecret],
  },
  async (request, response) => {
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
              await handleSubscriptionCreated(event);
              break;

            case 'customer.subscription.updated':
              await handleSubscriptionUpdated(event);
              break;

            case 'customer.subscription.deleted':
              await handleSubscriptionDeleted(event);
              break;

            case 'invoice.payment_succeeded':
              await handlePaymentSucceeded(event);
              break;

            case 'invoice.payment_failed':
              await handlePaymentFailed(event);
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
          response
            .status(200)
            .json({ received: true, error: 'Processing failed but acknowledged' });
        }
      },
    );
  },
);

/**
 * Handle customer.subscription.created event.
 * This is fired when a new subscription is created.
 */
async function handleSubscriptionCreated(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  console.log(`Processing subscription created: ${subscription.id}`);
  console.log('Subscription details:', {
    id: subscription.id,
    customer: subscription.customer,
    status: subscription.status,
    current_period_end: subscription.current_period_end,
    created: subscription.created,
    eventId: event.id,
  });

  try {
    const customerId = subscription.customer as string;
    const db = admin.firestore();

    // Quick check if event already processed (outside transaction for performance)
    const processedEventRef = db.collection('processedWebhookEvents').doc(event.id);
    const processedEventDoc = await processedEventRef.get();

    if (processedEventDoc.exists) {
      console.log(`Event ${event.id} already processed, skipping`);
      return;
    }

    // Find account by stripeCustomerId
    const accountsSnapshot = await db
      .collection('accounts')
      .where('stripeCustomerId', '==', customerId)
      .limit(1)
      .get();

    if (accountsSnapshot.empty) {
      console.warn(`No account found for Stripe customer ${customerId}`);
      return;
    }

    const accountDoc = accountsSnapshot.docs[0];
    const accountId = accountDoc.id;

    // Process in transaction for atomicity
    await db.runTransaction(async (transaction) => {
      // Re-read account in transaction
      const currentAccountDoc = await transaction.get(accountDoc.ref);
      const accountData = currentAccountDoc.data() as Account;

      // Double-check if event was processed by another concurrent function
      const processedCheck = await transaction.get(processedEventRef);
      if (processedCheck.exists) {
        console.log(`Event ${event.id} was processed by concurrent function, skipping`);
        return;
      }

      // Check event ordering - only process if this event is newer
      if (
        accountData.stripeSubscriptionLastEvent &&
        event.created <= accountData.stripeSubscriptionLastEvent
      ) {
        console.log(
          `Discarding older subscription.created event (${event.created} <= ${accountData.stripeSubscriptionLastEvent})`,
        );
        // Still mark as processed to prevent reprocessing
        transaction.set(processedEventRef, {
          eventId: event.id,
          eventType: event.type,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      // Determine tier and expiration based on status
      let subscriptionTier: 'premium' | 'essentials' = 'essentials';
      let expiresAt: admin.firestore.Timestamp | null = null;

      console.log('[DEBUG subscription.created] Subscription status check:', {
        subscriptionId: subscription.id,
        status: subscription.status,
        isActiveOrTrialing: subscription.status === 'active' || subscription.status === 'trialing',
        current_period_end: subscription.current_period_end,
        current_period_end_type: typeof subscription.current_period_end,
      });

      if (subscription.status === 'active' || subscription.status === 'trialing') {
        subscriptionTier = 'premium';
        if (subscription.current_period_end) {
          expiresAt = admin.firestore.Timestamp.fromMillis(subscription.current_period_end * 1000);
          console.log('[DEBUG subscription.created] Set expiresAt:', {
            current_period_end: subscription.current_period_end,
            expiresAt: expiresAt.toDate().toISOString(),
          });
        } else {
          console.warn('[DEBUG subscription.created] current_period_end is missing or falsy:', {
            current_period_end: subscription.current_period_end,
            subscriptionId: subscription.id,
          });
        }
      } else {
        console.log('[DEBUG subscription.created] Subscription status is not active/trialing:', {
          status: subscription.status,
          subscriptionId: subscription.id,
        });
      }

      console.log('[DEBUG subscription.created] Final values before update:', {
        accountId,
        subscriptionTier,
        expiresAt: expiresAt ? expiresAt.toDate().toISOString() : null,
        stripeSubscriptionEnds: subscription.current_period_end || null,
      });

      // Atomically update account
      transaction.update(accountDoc.ref, {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionStatus: subscription.status,
        stripeSubscriptionEnds: subscription.current_period_end || null,
        stripeSubscriptionLastEvent: event.created,
        subscriptionTier,
        expiresAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Mark event as processed
      transaction.set(processedEventRef, {
        eventId: event.id,
        eventType: event.type,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(
        `Successfully processed subscription.created for account ${accountId}: tier=${subscriptionTier}, status=${subscription.status}, expiresAt=${expiresAt ? expiresAt.toDate().toISOString() : null}`,
      );
    });
  } catch (error) {
    console.error('Error handling subscription created:', error);
    throw error;
  }
}

/**
 * Handle customer.subscription.updated event.
 * This is fired when a subscription is modified (e.g., plan change, status change).
 */
async function handleSubscriptionUpdated(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  console.log(`Processing subscription updated: ${subscription.id}`);
  console.log('Subscription details:', {
    id: subscription.id,
    customer: subscription.customer,
    status: subscription.status,
    current_period_end: subscription.current_period_end,
    created: subscription.created,
    eventId: event.id,
  });

  try {
    const customerId = subscription.customer as string;
    const db = admin.firestore();

    // Quick check if event already processed (outside transaction for performance)
    const processedEventRef = db.collection('processedWebhookEvents').doc(event.id);
    const processedEventDoc = await processedEventRef.get();

    if (processedEventDoc.exists) {
      console.log(`Event ${event.id} already processed, skipping`);
      return;
    }

    // Find account by stripeCustomerId
    const accountsSnapshot = await db
      .collection('accounts')
      .where('stripeCustomerId', '==', customerId)
      .limit(1)
      .get();

    if (accountsSnapshot.empty) {
      console.warn(`No account found for Stripe customer ${customerId}`);
      return;
    }

    const accountDoc = accountsSnapshot.docs[0];
    const accountId = accountDoc.id;

    // Process in transaction for atomicity
    await db.runTransaction(async (transaction) => {
      // Re-read account in transaction
      const currentAccountDoc = await transaction.get(accountDoc.ref);
      const accountData = currentAccountDoc.data() as Account;

      // Double-check if event was processed by another concurrent function
      const processedCheck = await transaction.get(processedEventRef);
      if (processedCheck.exists) {
        console.log(`Event ${event.id} was processed by concurrent function, skipping`);
        return;
      }

      // Check event ordering - only process if this event is newer
      if (
        accountData.stripeSubscriptionLastEvent &&
        event.created <= accountData.stripeSubscriptionLastEvent
      ) {
        console.log(
          `Discarding older subscription.updated event (${event.created} <= ${accountData.stripeSubscriptionLastEvent})`,
        );
        // Still mark as processed to prevent reprocessing
        transaction.set(processedEventRef, {
          eventId: event.id,
          eventType: event.type,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      // Determine tier and expiration based on status
      let subscriptionTier: 'premium' | 'essentials' = 'essentials';
      let expiresAt: admin.firestore.Timestamp | null = null;

      console.log('[DEBUG subscription.updated] Subscription status check:', {
        subscriptionId: subscription.id,
        status: subscription.status,
        isActiveOrTrialing: subscription.status === 'active' || subscription.status === 'trialing',
        current_period_end: subscription.current_period_end,
        current_period_end_type: typeof subscription.current_period_end,
      });

      if (subscription.status === 'active' || subscription.status === 'trialing') {
        subscriptionTier = 'premium';
        if (subscription.current_period_end) {
          expiresAt = admin.firestore.Timestamp.fromMillis(subscription.current_period_end * 1000);
          console.log('[DEBUG subscription.updated] Set expiresAt:', {
            current_period_end: subscription.current_period_end,
            expiresAt: expiresAt.toDate().toISOString(),
          });
        } else {
          console.warn('[DEBUG subscription.updated] current_period_end is missing or falsy:', {
            current_period_end: subscription.current_period_end,
            subscriptionId: subscription.id,
          });
        }
      } else {
        console.log('[DEBUG subscription.updated] Subscription status is not active/trialing:', {
          status: subscription.status,
          subscriptionId: subscription.id,
        });
      }

      console.log('[DEBUG subscription.updated] Final values before update:', {
        accountId,
        subscriptionTier,
        expiresAt: expiresAt ? expiresAt.toDate().toISOString() : null,
        stripeSubscriptionEnds: subscription.current_period_end || null,
      });

      // Atomically update account
      transaction.update(accountDoc.ref, {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionStatus: subscription.status,
        stripeSubscriptionEnds: subscription.current_period_end || null,
        stripeSubscriptionLastEvent: event.created,
        subscriptionTier,
        expiresAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Mark event as processed
      transaction.set(processedEventRef, {
        eventId: event.id,
        eventType: event.type,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(
        `Successfully processed subscription.updated for account ${accountId}: tier=${subscriptionTier}, status=${subscription.status}, expiresAt=${expiresAt ? expiresAt.toDate().toISOString() : null}`,
      );
    });
  } catch (error) {
    console.error('Error handling subscription updated:', error);
    throw error;
  }
}

/**
 * Handle customer.subscription.deleted event.
 * This is fired when a subscription is canceled or expires.
 */
async function handleSubscriptionDeleted(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  console.log(`Processing subscription deleted: ${subscription.id}`, { eventId: event.id });

  try {
    const customerId = subscription.customer as string;
    const db = admin.firestore();

    // Quick check if event already processed (outside transaction for performance)
    const processedEventRef = db.collection('processedWebhookEvents').doc(event.id);
    const processedEventDoc = await processedEventRef.get();

    if (processedEventDoc.exists) {
      console.log(`Event ${event.id} already processed, skipping`);
      return;
    }

    // Find account by stripeCustomerId
    const accountsSnapshot = await db
      .collection('accounts')
      .where('stripeCustomerId', '==', customerId)
      .limit(1)
      .get();

    if (accountsSnapshot.empty) {
      console.warn(`No account found for Stripe customer ${customerId}`);
      return;
    }

    const accountDoc = accountsSnapshot.docs[0];
    const accountId = accountDoc.id;

    // Process in transaction for atomicity
    await db.runTransaction(async (transaction) => {
      // Double-check if event was processed by another concurrent function
      const processedCheck = await transaction.get(processedEventRef);
      if (processedCheck.exists) {
        console.log(`Event ${event.id} was processed by concurrent function, skipping`);
        return;
      }

      // Downgrade account to essentials
      transaction.update(accountDoc.ref, {
        subscriptionTier: 'essentials',
        expiresAt: null,
        stripeSubscriptionStatus: 'canceled',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Mark event as processed
      transaction.set(processedEventRef, {
        eventId: event.id,
        eventType: event.type,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Successfully downgraded account ${accountId} to essentials`);
    });
  } catch (error) {
    console.error('Error handling subscription deleted:', error);
    throw error;
  }
}

/**
 * Handle invoice.payment_succeeded event.
 * This is fired when a subscription payment succeeds (including renewals).
 * Only tracks payment status - subscription tier is managed by subscription events.
 */
async function handlePaymentSucceeded(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  console.log(`Processing payment succeeded: ${invoice.id}`, { eventId: event.id });

  // Log invoice details for debugging
  console.log('Invoice details:', {
    id: invoice.id,
    customer: invoice.customer,
    billing_reason: invoice.billing_reason,
    status: invoice.status,
  });

  try {
    const customerId = invoice.customer as string;
    const db = admin.firestore();

    // Quick check if event already processed (outside transaction for performance)
    const processedEventRef = db.collection('processedWebhookEvents').doc(event.id);
    const processedEventDoc = await processedEventRef.get();

    if (processedEventDoc.exists) {
      console.log(`Event ${event.id} already processed, skipping`);
      return;
    }

    // Find account by stripeCustomerId
    const accountsSnapshot = await db
      .collection('accounts')
      .where('stripeCustomerId', '==', customerId)
      .limit(1)
      .get();

    if (accountsSnapshot.empty) {
      console.warn(`No account found for Stripe customer ${customerId}`);
      return;
    }

    const accountDoc = accountsSnapshot.docs[0];
    const accountId = accountDoc.id;

    // Process in transaction for atomicity
    await db.runTransaction(async (transaction) => {
      // Double-check if event was processed by another concurrent function
      const processedCheck = await transaction.get(processedEventRef);
      if (processedCheck.exists) {
        console.log(`Event ${event.id} was processed by concurrent function, skipping`);
        return;
      }

      // Update only payment tracking fields
      transaction.update(accountDoc.ref, {
        stripeSubscriptionPaid: true,
        lastPaymentFailedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Mark event as processed
      transaction.set(processedEventRef, {
        eventId: event.id,
        eventType: event.type,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Successfully recorded payment success for account ${accountId}`);
    });
  } catch (error) {
    console.error('Error handling payment succeeded:', error);
    throw error;
  }
}

/**
 * Handle invoice.payment_failed event.
 * This is fired when a subscription payment fails.
 * Only tracks payment status - subscription tier is managed by subscription events.
 */
async function handlePaymentFailed(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  console.log(`Processing payment failed: ${invoice.id}`, { eventId: event.id });

  // Log invoice details for debugging
  console.log('Invoice details:', {
    id: invoice.id,
    customer: invoice.customer,
    billing_reason: invoice.billing_reason,
    status: invoice.status,
  });

  try {
    const customerId = invoice.customer as string;
    const db = admin.firestore();

    // Quick check if event already processed (outside transaction for performance)
    const processedEventRef = db.collection('processedWebhookEvents').doc(event.id);
    const processedEventDoc = await processedEventRef.get();

    if (processedEventDoc.exists) {
      console.log(`Event ${event.id} already processed, skipping`);
      return;
    }

    // Find account by stripeCustomerId
    const accountsSnapshot = await db
      .collection('accounts')
      .where('stripeCustomerId', '==', customerId)
      .limit(1)
      .get();

    if (accountsSnapshot.empty) {
      console.warn(`No account found for Stripe customer ${customerId}`);
      return;
    }

    const accountDoc = accountsSnapshot.docs[0];
    const accountId = accountDoc.id;

    // Process in transaction for atomicity
    await db.runTransaction(async (transaction) => {
      // Double-check if event was processed by another concurrent function
      const processedCheck = await transaction.get(processedEventRef);
      if (processedCheck.exists) {
        console.log(`Event ${event.id} was processed by concurrent function, skipping`);
        return;
      }

      // Update only payment tracking fields
      transaction.update(accountDoc.ref, {
        stripeSubscriptionPaid: false,
        lastPaymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Mark event as processed
      transaction.set(processedEventRef, {
        eventId: event.id,
        eventType: event.type,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`Successfully recorded payment failure for account ${accountId}`);
      // Note: We don't downgrade here - subscription events will handle tier changes if needed
    });
  } catch (error) {
    console.error('Error handling payment failed:', error);
    throw error;
  }
}
