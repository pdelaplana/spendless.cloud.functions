# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Spendless Cloud Functions is a Firebase Cloud Functions backend for the Spendless Ionic PWA application. It handles asynchronous job processing, data exports, account deletions, email notifications, and system health monitoring.

## Development Commands

All commands should be run from the `functions/` directory:

```bash
# Build
npm run build              # Compile TypeScript
npm run build:watch        # Compile in watch mode

# Testing
npm test                   # Run all tests
npm test -- <filename>     # Run specific test file (e.g., npm test -- sendWelcomeEmail)
npm run test:watch         # Run tests in watch mode
npm run test:coverage      # Run tests with coverage report

# Code Quality
npm run lint              # Check code with Biome
npm run lint:fix          # Auto-fix linting issues
npm run biome:fix         # Fix both linting and formatting

# Local Development
npm run serve             # Start Firebase emulators
npm run shell             # Interactive shell for testing functions

# Deployment
npm run deploy            # Deploy to Firebase (use with caution)

# Configuration (Windows)
.\scripts\configure-stripe.ps1  # Configure Stripe for dev/prod environments
```

## Architecture

### Function Types

**HTTPS Callable Functions** (require authentication):
- `exportData` - Allows users to export their data
- `deleteAccount` - Permanently deletes user accounts and all data
- `queueJob` - Adds jobs to the processing queue
- `createCheckoutSession` - Creates a Stripe Checkout session for premium subscription
- `createCustomerPortalSession` - Creates a Stripe Customer Portal session for subscription management

**HTTP Functions**:
- `healthcheck` - System health monitoring endpoint
- `handleStripeWebhook` - Processes Stripe webhook events for subscription lifecycle management

**Firestore Triggers**:
- `processJob` - Processes jobs from the `jobs/` collection when created
- `sendWelcomeEmail` - Sends welcome email when Account document is created

### Job Processing System

The codebase implements an asynchronous job queue pattern:

1. **Client calls `queueJob`** → Creates a document in Firestore `jobs` collection with status `pending`
2. **Firestore onCreate trigger fires `processJob`** → Picks up the job document
3. **`processJob` routes to job handler** → Based on `jobType` field, calls appropriate handler from `jobs/` directory
4. **Job executes and updates status** → Sets status to `completed` or `failed`

**Job Types** (defined in `types.ts`):
- `exportData` - Export user data to CSV
- `deleteAccount` - Delete user account and all associated data

To add a new job type:
1. Add type to `JobType` union in `types.ts`
2. Create handler in `jobs/` directory
3. Add case to switch statement in `processJob.ts`

### Code Organization

```
functions/src/
├── index.ts              # Entry point - exports all functions
├── startup.ts            # Initialization (Sentry, Firebase Admin)
├── types.ts              # Shared TypeScript types
├── config/               # Configuration modules
│   └── stripe.ts         # Stripe client initialization
├── helpers/              # Utility functions
│   └── sendEmail.ts      # Mailgun email helper
├── jobs/                 # Job handler implementations
│   ├── exportData.ts     # Data export logic
│   └── deleteAccount.ts  # Account deletion logic
├── stripe/               # Stripe integration functions
│   ├── createCheckoutSession.ts        # Checkout session creation
│   ├── createCustomerPortalSession.ts  # Customer portal creation
│   ├── handleStripeWebhook.ts          # Webhook event processing
│   └── helpers.ts                      # Stripe utility functions
├── templates/emails/     # Email templates (markdown)
│   └── welcome-email.md
├── queueJob.ts           # HTTPS callable - queues jobs
├── processJob.ts         # Firestore trigger - processes queued jobs
├── exportData.ts         # HTTPS callable wrapper for exportData job
├── deleteAccount.ts      # HTTPS callable wrapper for deleteAccount job
├── sendWelcomeEmail.ts   # Firestore trigger - sends welcome emails
├── healthCheck.ts        # HTTP function for monitoring
└── __tests__/            # Jest unit tests
```

### Key Patterns

**Authentication Pattern** (HTTPS Callable functions):
```typescript
if (request?.auth === null) {
  throw new HttpsError('unauthenticated', 'User must be authenticated...');
}
const userId = request.auth?.uid;
```

**Sentry Instrumentation**:
All functions wrap their main logic in `Sentry.startSpan()` for performance tracking and error monitoring.

**Error Handling**:
- HTTPS Callable functions throw `HttpsError` for client-facing errors
- Background jobs (Firestore triggers) catch errors, log to Sentry, and return error status without throwing
- Email failures are logged but never block the main operation

**Firestore Data Deletion**:
When deleting data, always remember to:
1. Delete subcollections first (Firestore doesn't cascade delete)
2. Delete nested subcollections (e.g., `periods/{periodId}/wallets`)
3. Delete storage files with appropriate prefix
4. Delete Firebase Auth user record

### Testing Patterns

**Mocking Firebase Admin**:
```typescript
jest.mock('firebase-admin', () => ({
  firestore: jest.fn().mockReturnValue({ collection: jest.fn() }),
  storage: jest.fn().mockReturnValue({ bucket: jest.fn() }),
  auth: jest.fn().mockReturnValue({ getUser: jest.fn() }),
}));
```

**Mocking Sentry**:
```typescript
jest.mock('@sentry/node', () => ({
  default: { startSpan: jest.fn().mockImplementation((_options, fn) => fn()) },
  startSpan: jest.fn().mockImplementation((_options, fn) => fn()),
  captureException: jest.fn(),
}));
```

**Testing Firestore Triggers**:
Create mock events with `params` and `data` fields. Do not use `firebase-functions-test` for creating events as it conflicts with mocked Firebase Admin.

## Environment Variables

Required for local development (create `functions/.env`):
- `SENTRY_DSN` - Sentry error tracking DSN
- `ENVIRONMENT` - Application environment (development/staging/production)
- `MAILGUN_API_KEY` - Mailgun API key
- `MAILGUN_DOMAIN` - Mailgun sending domain

Local development also requires:
- `functions/spendless-firebase-adminsdk.json` - Firebase Admin SDK service account key

## Build Process

The build process compiles TypeScript and copies template files:

```bash
npm run build  # Runs: tsc && npm run copy:templates
```

The `copy:templates` script (`scripts/copy-templates.js`) copies `src/templates/` to `lib/templates/` so that compiled functions can access template files at runtime. This ensures templates are available in the deployed Firebase Functions environment without deploying the entire `src/` directory.

## Email Templates

Email templates are stored in `src/templates/emails/` as Markdown files with special structure:

```markdown
## Subject Line
Email subject with {variables}

## Email Body
Email body content with {variables}

---

## Email Footer
(Optional footer content)
```

During build, templates are copied to `lib/templates/` and accessed at runtime via:
```typescript
const templatePath = path.join(__dirname, 'templates', 'emails', 'welcome-email.md');
```

Template variables are replaced using `replaceTemplateVariables()` helper function. The body is converted from Markdown to HTML using `convertMarkdownToHtml()`.

## Firebase Collections

Key Firestore collections:
- `accounts/{userId}` - User account data
- `accounts/{userId}/periods` - Spending periods
- `accounts/{userId}/periods/{periodId}/wallets` - Wallets within periods
- `accounts/{userId}/spending` - Spending transactions
- `jobs/{jobId}` - Job queue

## Stripe Integration

This project includes Stripe integration for premium subscription management.

### Stripe Functions

**`createCheckoutSession` (HTTPS Callable)**:
- Creates a Stripe Checkout session for users to upgrade to premium
- Input: `{ priceId, successUrl?, cancelUrl? }`
- Output: `{ sessionId, url }`
- Validates price ID against configured monthly/annual prices
- Creates or retrieves Stripe customer
- Prevents multiple active subscriptions

**`createCustomerPortalSession` (HTTPS Callable)**:
- Creates a Stripe Customer Portal session for subscription management
- Input: `{ returnUrl? }`
- Output: `{ url }`
- Allows users to update payment methods, cancel subscriptions, view invoices

**`handleStripeWebhook` (HTTP)**:
- Processes Stripe webhook events
- Verifies webhook signatures for security
- Handles events:
  - `customer.subscription.created` - New subscription created
  - `customer.subscription.updated` - Subscription modified
  - `customer.subscription.deleted` - Subscription canceled/expired
  - `invoice.payment_succeeded` - Payment successful (including renewals)
  - `invoice.payment_failed` - Payment failed
- Updates Firestore account documents with subscription status

### Stripe Code Organization

```
functions/src/
├── config/
│   └── stripe.ts             # Stripe client initialization and configuration
├── stripe/
│   ├── createCheckoutSession.ts       # Checkout session creation
│   ├── createCustomerPortalSession.ts # Customer portal creation
│   ├── handleStripeWebhook.ts         # Webhook event processing
│   └── helpers.ts                     # Stripe utility functions
└── __tests__/stripe/         # Stripe function tests
    ├── createCheckoutSession.spec.ts
    ├── createCustomerPortalSession.spec.ts
    └── handleStripeWebhook.spec.ts
```

### Stripe Helper Functions

Located in `stripe/helpers.ts`:
- `getOrCreateStripeCustomer()` - Get or create Stripe customer for an account
- `getAccountIdByUserId()` - Retrieve account ID from user ID
- `hasActiveSubscription()` - Check if account has active subscription
- `updateAccountSubscription()` - Update account with subscription data
- `downgradeToEssentials()` - Downgrade account to free tier
- `getAccountIdFromStripeCustomer()` - Get account ID from Stripe customer metadata

### Stripe Environment Variables

**Firebase Functions v2 Configuration**

This project uses Firebase Functions v2, which requires environment variables and Cloud Secret Manager instead of the deprecated `functions.config()` API.

**Local Development** (add to `functions/.env`):
```bash
# Stripe Configuration
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRICE_ID_MONTHLY="price_..."
STRIPE_PRICE_ID_ANNUAL="price_..."

# Frontend URL for redirects (optional, defaults to localhost:8100)
FRONTEND_URL="http://localhost:8100"
```

**Production Deployment**:

For production, you must migrate from the deprecated `functions:config` to Cloud Secret Manager:

1. **Set secrets using Cloud Secret Manager** (recommended for sensitive data):
```bash
# Set secret key (will prompt for value)
firebase functions:secrets:set STRIPE_SECRET_KEY --project your-project-id

# Set webhook secret (will prompt for value)
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project your-project-id
```

2. **Set environment variables** for non-sensitive data (price IDs):
```bash
# Via .env.<project-id> file
echo "STRIPE_PRICE_ID_MONTHLY=price_..." >> functions/.env.your-project-id
echo "STRIPE_PRICE_ID_ANNUAL=price_..." >> functions/.env.your-project-id
```

Or set via Firebase Console: Functions > Configuration > Environment Variables

**Migration Script** (Windows PowerShell):

A PowerShell script is available to migrate from the deprecated `functions:config` to v2 secrets:

```powershell
# Migrate both dev and production environments
.\functions\scripts\migrate-to-v2-secrets.ps1

# Migrate only dev
.\functions\scripts\migrate-to-v2-secrets.ps1 -Environment dev

# Migrate only prod
.\functions\scripts\migrate-to-v2-secrets.ps1 -Environment prod
```

The script will:
- Read existing configuration from `functions:config`
- Migrate secrets to Cloud Secret Manager
- Provide instructions for setting environment variables
- Display next steps for cleanup

**⚠️ Important**: The old `functions:config` API will be shut down on December 31, 2025. You must migrate before then.

### Stripe Firestore Schema

The `accounts` collection includes Stripe-related fields:
```typescript
interface Account {
  // Existing fields
  id: string;
  userId: string;
  subscriptionTier: 'essentials' | 'premium';
  expiresAt: Timestamp | null;

  // Stripe fields
  stripeCustomerId?: string;           // Stripe customer ID
  stripeSubscriptionId?: string;       // Current subscription ID
  stripeSubscriptionStatus?: string;   // Subscription status (active, canceled, etc.)
  lastPaymentFailedAt?: Timestamp;     // Last payment failure timestamp
}
```

### Webhook Configuration

After deploying, configure the webhook endpoint in Stripe Dashboard:
```
https://us-central1-<project-id>.cloudfunctions.net/handleStripeWebhook
```

Events to subscribe to:
- customer.subscription.created
- customer.subscription.updated
- customer.subscription.deleted
- invoice.payment_succeeded
- invoice.payment_failed

## Node Version

This project requires **Node.js 22** (specified in `package.json` engines field).
