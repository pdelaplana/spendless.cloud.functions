import * as Sentry from '@sentry/node';

import {
  onDocumentCreated,
} from 'firebase-functions/v2/firestore';
import { exportData } from './jobs/exportData';
import { Job } from './types';


export const processJob = onDocumentCreated('jobs/{jobId}', async (event) => {
  Sentry.startSpan({name: 'processJob', op: 'function.firestore.onDocumentCreated'}, async (span) => {
    const jobId = event.params.jobId;
    const snapshot = event.data;
    if (!snapshot) {
      console.error(`No data found for job ID: ${jobId}`);
      return;
    };

    const job = snapshot.data() as Job;

    // Log the job data
    console.log(`Processing job: ${jobId}`, job);

    // Process the job based on its type
    switch (job.jobType) {
      case 'exportData':
        await exportData(job);
        break;

      default:
        console.error(`Unknown job type: ${job.jobType}`);
        break;
    }

    return null;

  });


});
