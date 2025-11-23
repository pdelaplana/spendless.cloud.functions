import path from 'node:path';
import Sentry from '@sentry/node';
import admin from 'firebase-admin';
import {
  type HistoricalDataForAi,
  type PeriodInfoForAi,
  type SpendingDataForAi,
  generateAiInsights,
} from '../helpers/aiInsights';
import { sendEmailNotification } from '../helpers/sendEmail';
import { hasActiveSubscription } from '../stripe/helpers';
import type { Account, AiInsight } from '../types';

/**
 * Load and process email template for AI Checkin
 */
async function loadAiCheckinEmailTemplate(
  insights: string,
  periodName: string,
  userName: string,
): Promise<{ subject: string; html: string }> {
  try {
    const fs = await import('node:fs/promises');
    const templatePath = path.join(__dirname, 'templates', 'emails', 'ai-checkin.md');
    const template = await fs.readFile(templatePath, 'utf-8');

    // Simple template processing - split by ## headers
    const sections = template.split('##').filter((s) => s.trim());

    let subject = '';
    let body = '';

    for (const section of sections) {
      const lines = section.trim().split('\n');
      const header = lines[0].trim();

      if (header.toLowerCase().includes('subject')) {
        subject = lines.slice(1).join('\n').trim();
      } else if (header.toLowerCase().includes('body')) {
        body = lines.slice(1).join('\n').trim();
      }
    }

    // Replace variables
    subject = subject.replace(/{periodName}/g, periodName).replace(/{userName}/g, userName);

    body = body
      .replace(/{periodName}/g, periodName)
      .replace(/{userName}/g, userName)
      .replace(/{insights}/g, insights);

    // Convert markdown to HTML (basic conversion)
    const htmlBody = body
      .replace(/### (.+)/g, '<h3>$1</h3>')
      .replace(/## (.+)/g, '<h2>$1</h2>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^- (.+)/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(.+)$/gm, '<p>$1</p>');

    return { subject, html: htmlBody };
  } catch (_error) {
    // Fallback if template doesn't exist
    console.warn('AI checkin email template not found, using fallback');
    return {
      subject: `Your ${periodName} Spending Insights`,
      html: `
        <h2>Your ${periodName} Spending Insights</h2>
        <p>Hi ${userName},</p>
        <p>Here are your AI-generated spending insights:</p>
        ${insights.replace(/\n/g, '<br>')}
        <p>Keep up the great work managing your spending!</p>
      `,
    };
  }
}

/**
 * Generate AI Checkin for a user
 * This job fetches spending data, analyzes it with AI, stores insights, and sends an email
 */
export const generateAiCheckin = async ({
  userId,
  userEmail,
  periodId,
  analysisType,
}: {
  userId: string;
  userEmail: string;
  periodId?: string;
  analysisType?: 'weekly' | 'period-end';
}) => {
  return Sentry.startSpan(
    { name: 'generateAiCheckin', op: 'function.job.generateAiCheckin' },
    async () => {
      if (!userId) {
        throw new Error('User ID is required.');
      }

      try {
        const db = admin.firestore();
        const accountRef = db.collection('accounts').doc(userId);

        // Get account data
        const accountSnapshot = await accountRef.get();
        if (!accountSnapshot.exists) {
          throw new Error(`Account with ID ${userId} not found.`);
        }

        const account = accountSnapshot.data() as Account;
        const accountId = account.id;

        // Check if user has active premium subscription
        const hasPremium = await hasActiveSubscription(accountId);
        if (!hasPremium) {
          throw new Error('AI Checkin is only available for premium subscribers.');
        }

        // Check if AI Checkin is enabled for this account
        if (account.aiCheckinEnabled === false) {
          throw new Error('AI Checkin is disabled for this account.');
        }

        // Determine analysis type
        const finalAnalysisType: 'weekly' | 'period-end' = analysisType || 'weekly';

        // Get periods
        const periodsSnapshot = await accountRef
          .collection('periods')
          .orderBy('startAt', 'desc')
          .get();
        const periods = periodsSnapshot.docs;

        if (periods.length === 0) {
          throw new Error('No periods found for this account.');
        }

        // Determine which period to analyze
        let currentPeriod: FirebaseFirestore.QueryDocumentSnapshot;
        if (periodId) {
          const found = periods.find((p) => p.id === periodId);
          if (!found) {
            throw new Error(`Period ${periodId} not found.`);
          }
          currentPeriod = found;
        } else {
          // Use most recent period
          currentPeriod = periods[0];
        }

        const periodData = currentPeriod.data();

        // Get spending data for the current period
        const spendingSnapshot = await accountRef
          .collection('spending')
          .where('periodId', '==', currentPeriod.id)
          .orderBy('date', 'desc')
          .get();

        if (spendingSnapshot.empty) {
          throw new Error('No spending data found for this period.');
        }

        // Format spending data for AI
        const spendingData: SpendingDataForAi[] = spendingSnapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            date: data.date.toDate(),
            amount: data.amount,
            description: data.description,
            category: data.category,
            notes: data.notes,
            tags: data.tags || [],
            recurring: data.recurring || false,
          };
        });

        // Prepare period info
        const periodInfo: PeriodInfoForAi = {
          name: periodData.name,
          startDate: periodData.startAt.toDate(),
          endDate: periodData.endAt.toDate(),
          targetSpend: periodData.targetSpend,
          targetSavings: periodData.targetSavings,
          goals: periodData.goals,
        };

        // Get historical data from previous period for comparison
        let historicalData: HistoricalDataForAi | undefined;
        if (periods.length > 1) {
          const previousPeriod = periods[1];
          const prevSpendingSnapshot = await accountRef
            .collection('spending')
            .where('periodId', '==', previousPeriod.id)
            .get();

          if (!prevSpendingSnapshot.empty) {
            const prevSpending = prevSpendingSnapshot.docs.map((doc) => doc.data());
            const prevTotal = prevSpending.reduce((sum, s) => sum + s.amount, 0);

            // Calculate top categories
            const categoryTotals = prevSpending.reduce(
              (acc, s) => {
                acc[s.category] = (acc[s.category] || 0) + s.amount;
                return acc;
              },
              {} as Record<string, number>,
            );
            const topCategories = Object.entries(categoryTotals)
              .map(([category, amount]) => ({ category, amount }))
              .sort((a, b) => b.amount - a.amount)
              .slice(0, 5);

            // Calculate top tags
            const tagTotals = prevSpending.reduce(
              (acc, s) => {
                if (s.tags && Array.isArray(s.tags)) {
                  for (const tag of s.tags) {
                    acc[tag] = (acc[tag] || 0) + s.amount;
                  }
                }
                return acc;
              },
              {} as Record<string, number>,
            );
            const topTags = Object.entries(tagTotals)
              .map(([tag, amount]) => ({ tag, amount }))
              .sort((a, b) => b.amount - a.amount)
              .slice(0, 5);

            historicalData = {
              totalSpending: prevTotal,
              transactionCount: prevSpending.length,
              topCategories,
              topTags,
            };
          }
        }

        // Generate AI insights
        console.log('Generating AI insights for user', userId);
        const { insights, formattedInsights, tokensUsed } = await generateAiInsights(
          spendingData,
          periodInfo,
          historicalData,
          account.currency || 'USD',
        );

        // Calculate metadata
        const totalSpending = spendingData.reduce((sum, s) => sum + s.amount, 0);
        const categoriesAnalyzed = [...new Set(spendingData.map((s) => s.category))];
        const tagsAnalyzed = [...new Set(spendingData.flatMap((s) => s.tags || []))];

        // Create AI Insight document
        const insightData: Omit<AiInsight, 'id'> = {
          userId,
          accountId,
          periodId: currentPeriod.id,
          periodName: periodData.name,
          periodStartDate: periodData.startAt,
          periodEndDate: periodData.endAt,
          analysisType: finalAnalysisType,
          totalSpendingAnalyzed: totalSpending,
          transactionCount: spendingData.length,
          categoriesAnalyzed,
          tagsAnalyzed,
          insights,
          formattedInsights,
          generatedAt: admin.firestore.Timestamp.now(),
          emailStatus: 'pending',
          aiModel: 'gemini-1.5-pro',
          tokensUsed,
        };

        // Store in Firestore
        const insightRef = await accountRef.collection('aiInsights').add(insightData);
        console.log('AI insight stored with ID:', insightRef.id);

        // Send email
        try {
          const { subject, html } = await loadAiCheckinEmailTemplate(
            formattedInsights,
            periodData.name,
            account.name,
          );

          await sendEmailNotification({
            from: '"Spendless AI Insights" <insights@spendless.app>',
            to: userEmail,
            subject,
            html,
          });

          // Update email status
          await insightRef.update({
            emailStatus: 'sent',
            emailSentAt: admin.firestore.Timestamp.now(),
          });

          console.log('AI checkin email sent to', userEmail);
        } catch (emailError) {
          // Log but don't fail the job if email fails
          console.error('Failed to send AI checkin email:', emailError);
          Sentry.captureException(emailError);

          await insightRef.update({
            emailStatus: 'failed',
          });
        }

        // Update lastAiCheckinAt in account
        await accountRef.update({
          lastAiCheckinAt: admin.firestore.Timestamp.now(),
        });

        return {
          success: true,
          message: `AI Checkin generated successfully for ${userEmail}.`,
          insightId: insightRef.id,
        };
      } catch (error) {
        Sentry.captureException(error);
        console.error('Error generating AI checkin:', error);
        return {
          success: false,
          message: `${error}`,
        };
      }
    },
  );
};
