import { onRequest } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';

export const healthcheck = onRequest((request, response) => {
  const healthCheck = {
    uptime: process.uptime(),
    message: 'OK',
    timestamp: Date.now(),
  };

  logger.info('Healthcheck', healthCheck, { structuredData: true });

  response.setHeader('Content-Type', 'application/json');
  response.send(JSON.stringify(healthCheck, null, 3));
});
