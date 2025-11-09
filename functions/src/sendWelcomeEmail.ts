import * as fs from 'node:fs';
import * as path from 'node:path';
import Sentry from '@sentry/node';
import admin from 'firebase-admin';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { sendEmailNotification } from './helpers/sendEmail';

/**
 * Extracts the first name from a display name
 * @param displayName - The full display name (e.g., "John Doe")
 * @returns The first name or "there" as fallback
 */
function extractFirstName(displayName: string | null | undefined): string {
  if (!displayName || displayName.trim() === '') {
    return 'there';
  }

  const parts = displayName.trim().split(/\s+/);
  return parts[0] || 'there';
}

/**
 * Loads and parses the welcome email template
 * @returns Object with subject and body from the template
 */
function loadEmailTemplate(): { subject: string; body: string } {
  // Templates are copied to lib/templates during build
  const templatePath = path.join(__dirname, 'templates', 'emails', 'welcome-email.md');
  const templateContent = fs.readFileSync(templatePath, 'utf-8');

  // Extract subject line (after "## Subject Line")
  const subjectMatch = templateContent.match(/## Subject Line\s*\n(.+)/);
  const subject = subjectMatch ? subjectMatch[1].trim() : 'Welcome to Spendless!';

  // Extract email body (after "## Email Body" until "---" or "## Email Footer")
  const bodyMatch = templateContent.match(
    /## Email Body\s*\n([\s\S]*?)(?=\n---|## Email Footer|## Technical Notes|$)/,
  );
  const body = bodyMatch ? bodyMatch[1].trim() : '';

  return { subject, body };
}

/**
 * Replaces template variables with actual values
 * @param template - Template string with {variable} placeholders
 * @param variables - Object mapping variable names to values
 * @returns Processed template with variables replaced
 */
function replaceTemplateVariables(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    result = result.replace(regex, value);
  }
  return result;
}

/**
 * Converts markdown-style text to simple HTML
 * @param markdown - Markdown text
 * @returns HTML string
 */
function convertMarkdownToHtml(markdown: string): string {
  let html = markdown;

  // Convert headers (### Header -> <h3>Header</h3>)
  html = html.replace(/### (.+)/g, '<h3>$1</h3>');
  html = html.replace(/## (.+)/g, '<h2>$1</h2>');
  html = html.replace(/# (.+)/g, '<h1>$1</h1>');

  // Convert bold (**text** -> <strong>text</strong>)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Convert line breaks to <br> and paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  // Wrap in paragraph tags
  html = `<p>${html}</p>`;

  return html;
}

/**
 * Cloud Function that sends a welcome email when a new Account is created
 * Trigger: Firestore onCreate for accounts/{userId}
 */
export const sendWelcomeEmail = onDocumentCreated('accounts/{userId}', async (event) => {
  return Sentry.startSpan(
    { name: 'sendWelcomeEmail', op: 'function.firestore.onDocumentCreated' },
    async () => {
      const userId = event.params.userId;

      console.log(`Welcome email trigger fired for user: ${userId}`);

      try {
        // Fetch user from Firebase Auth
        const userRecord = await admin.auth().getUser(userId);

        if (!userRecord.email) {
          console.warn(`User ${userId} has no email address. Skipping welcome email.`);
          Sentry.captureMessage(`User ${userId} has no email address for welcome email`, 'warning');
          return null;
        }

        // Extract first name from displayName
        const firstName = extractFirstName(userRecord.displayName);

        // Load email template
        const template = loadEmailTemplate();

        // Prepare template variables
        const currentYear = new Date().getFullYear().toString();
        const variables = {
          firstName,
          founderName: 'Patrick',
          currentYear,
        };

        // Replace variables in subject and body
        const subject = replaceTemplateVariables(template.subject, variables);
        const bodyMarkdown = replaceTemplateVariables(template.body, variables);

        // Convert markdown to HTML
        const bodyHtml = convertMarkdownToHtml(bodyMarkdown);

        // Send email via Mailgun
        await sendEmailNotification({
          from: '"Spendless" <patrick@getspendless.com>',
          to: userRecord.email,
          subject,
          html: bodyHtml,
        });

        console.log(`Welcome email sent successfully to ${userRecord.email} (User: ${userId})`);
      } catch (error) {
        // Log error but don't throw - email failures should not block account creation
        console.error(`Error sending welcome email for user ${userId}:`, error);
        Sentry.captureException(error, {
          extra: {
            userId,
            operation: 'sendWelcomeEmail',
          },
        });
      }

      return null;
    },
  );
});
