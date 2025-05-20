import * as Sentry from '@sentry/node';

import { Timestamp } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { deleteAccount } from './jobs/deleteAccount';
import { exportData } from './jobs/exportData';
import type { Job } from './types';

export const processJob = onDocumentCreated('jobs/{jobId}', async (event) => {
  return Sentry.startSpan(
    { name: 'processJob', op: 'function.firestore.onDocumentCreated' },
    async () => {
      const jobId = event.params.jobId;
      const snapshot = event.data;
      if (!snapshot) {
        console.error(`No data found for job ID: ${jobId}`);
        return;
      }

      const job = snapshot.data() as Job;

      // Log the job data
      console.log(`Processing job: ${jobId}`, job);

      let result = { success: false, message: 'Unknown error' };

      // Process the job based on its type
      switch (job.jobType) {
        case 'exportData':
          result = await exportData({ userId: job.userId, userEmail: job.userEmail });
          break;
        case 'deleteAccount':
          result = await deleteAccount({ userId: job.userId, userEmail: job.userEmail });
          break;
        default:
          console.error(`Unknown job type: ${job.jobType}`);
          break;
      }

      const jobRef = snapshot.ref;

      if (result.success) {
        // Update task status to completed
        await jobRef.update({
          status: 'completed',
          attempts: job.attempts + 1,
          completedAt: Timestamp.now(),
        });
      } else {
        await jobRef.update({
          status: 'failed',
          attempts: job.attempts + 1,
          errors: [result.message],
        });
      }

      return null;
    },
  );
});
