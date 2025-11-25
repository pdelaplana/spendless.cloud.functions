import * as Sentry from '@sentry/node';
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import * as functions from 'firebase-functions/v2';
import { geminiApiKey } from '../config/gemini';
import type { Account, Job } from '../types';

/**
 * Scheduled function to generate weekly AI Check-ins for eligible premium users.
 * Runs every Monday at 9:00 AM UTC to generate insights for users who have
 * weekly or both frequency settings enabled.
 *
 * Schedule: Every Monday at 9:00 AM UTC
 */
export const weeklyAiCheckin = functions.scheduler.onSchedule(
  {
    schedule: 'every monday 09:00',
    timeZone: 'UTC',
    secrets: [geminiApiKey],
  },
  async () => {
    return Sentry.startSpan(
      {
        name: 'weeklyAiCheckin',
        op: 'function.scheduled',
      },
      async () => {
        try {
          const db = admin.firestore();

          console.log('Starting weekly AI Checkin job queueing...');

          // Query accounts that are eligible for weekly AI checkins
          // Eligible accounts must:
          // 1. Have premium subscription tier
          // 2. Have aiCheckinEnabled = true
          // 3. Have aiCheckinFrequency = 'weekly' or 'both'
          const accountsSnapshot = await db
            .collection('accounts')
            .where('subscriptionTier', '==', 'premium')
            .where('aiCheckinEnabled', '==', true)
            .get();

          if (accountsSnapshot.empty) {
            console.log('No eligible accounts found for weekly AI checkin');
            return;
          }

          // Filter accounts by frequency preference
          const eligibleAccounts = accountsSnapshot.docs.filter((doc) => {
            const account = doc.data() as Account;
            const frequency = account.aiCheckinFrequency;
            return frequency === 'weekly' || frequency === 'both';
          });

          if (eligibleAccounts.length === 0) {
            console.log('No accounts with weekly frequency preference found');
            return;
          }

          console.log(`Found ${eligibleAccounts.length} eligible accounts for weekly AI checkin`);

          // Queue jobs for each eligible account
          let queuedCount = 0;
          let errorCount = 0;

          for (const accountDoc of eligibleAccounts) {
            try {
              const account = accountDoc.data() as Account;
              const userId = account.userId;

              // Get user email from Firebase Auth
              let userEmail = '';
              try {
                const userRecord = await admin.auth().getUser(userId);
                userEmail = userRecord.email || `user-${userId}@spendless.app`;
              } catch (authError) {
                console.warn(`Could not fetch email for user ${userId}:`, authError);
                userEmail = `user-${userId}@spendless.app`;
              }

              // Create job
              const job: Job = {
                userId,
                userEmail,
                jobType: 'generateAiCheckin',
                status: 'pending',
                priority: 1,
                createdAt: Timestamp.now(),
                completedAt: null,
                errors: [],
                attempts: 0,
                // Task-specific data
                analysisType: 'weekly',
                date: new Date().toISOString(), // Current date for weekly analysis
              } as Job & { analysisType: 'weekly'; date: string };

              // Queue the job
              const jobRef = await db.collection('jobs').add(job);

              console.log(`Queued weekly AI checkin job ${jobRef.id} for user ${userId}`);
              queuedCount++;
            } catch (error) {
              console.error(`Error queuing AI checkin for account ${accountDoc.id}:`, error);
              Sentry.captureException(error);
              errorCount++;
            }
          }

          console.log(
            `Weekly AI checkin job queueing complete. Queued: ${queuedCount}, Errors: ${errorCount}`,
          );

          // If there were any errors, throw to alert monitoring
          if (errorCount > 0 && queuedCount === 0) {
            throw new Error(`Failed to queue any AI checkin jobs. Total errors: ${errorCount}`);
          }
        } catch (error) {
          console.error('Error in weekly AI checkin scheduler:', error);
          Sentry.captureException(error);
          throw error;
        }
      },
    );
  },
);
