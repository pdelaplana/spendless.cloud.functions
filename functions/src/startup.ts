import * as fs from 'node:fs';
import * as Sentry from '@sentry/node';
// filepath: d:\Repos\spendless\spendless.cloud.functions\functions\src\startup.ts
import * as admin from 'firebase-admin';
import { defineString } from 'firebase-functions/params';

const sentryDsnConfig = defineString('SENTRY_DSN');
const envConfig = defineString('ENV');

// Initialize Sentry with environment variables when available
Sentry.init({
  dsn: sentryDsnConfig.value() || '',
  environment: envConfig.value() || 'development',
  tracesSampleRate: 1.0,
});

// Initialize Firebase Admin SDK
try {
  // In production/CI environment, use service account from env or file
  if (fs.existsSync('./spendless-firebase-adminsdk.json')) {
    admin.initializeApp({
      credential: admin.credential.cert('./spendless-firebase-adminsdk.json'),
    });
  } else {
    // Default initialization for production environment
    admin.initializeApp();
  }
  console.log('Firebase Admin SDK initialized successfully');
} catch (error) {
  console.error('Error initializing Firebase Admin SDK:', error);
  throw error;
}
