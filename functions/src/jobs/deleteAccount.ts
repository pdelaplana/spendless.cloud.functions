import Sentry from '@sentry/node';
import admin from 'firebase-admin';
import { params } from 'firebase-functions';
import { sendEmailNotification } from '../helpers/sendEmail';

export const deleteAccount = async ({
  userId,
  userEmail,
}: { userId: string; userEmail: string }) => {
  return Sentry.startSpan({ name: 'deleteAccount', op: 'function.job.deleteAccount' }, async () => {
    if (!userId) {
      throw new Error('User ID is required.');
    }

    try {
      // Get a reference to the account document
      const accountRef = admin.firestore().collection('accounts').doc(userId);

      // Get account data before deletion (for audit/confirmation purposes)
      const accountSnapshot = await accountRef.get();

      if (!accountSnapshot.exists) {
        throw new Error(`Account with ID ${userId} not found.`);
      }

      // Delete subcollections first (periods and spending)
      // Note: Firestore doesn't automatically delete subcollections when a document is deleted

      // 1. Delete periods subcollection
      const periodsSnapshot = await accountRef.collection('periods').get();
      const deletePeriodPromises = periodsSnapshot.docs.map(async (doc) => {
        await doc.ref.delete();
      });
      await Promise.all(deletePeriodPromises);

      // 2. Delete spending subcollection
      const spendingSnapshot = await accountRef.collection('spending').get();
      const deleteSpendingPromises = spendingSnapshot.docs.map(async (doc) => {
        await doc.ref.delete();
      });
      await Promise.all(deleteSpendingPromises);

      // 3. Delete the main account document
      await accountRef.delete();

      // 4. Delete user from Firebase Authentication
      await admin.auth().deleteUser(userId);

      // 5. Delete user's storage files
      try {
        // Get storage bucket name from parameters or use default
        const defaultBucket = params.storageBucket.value() || admin.storage().bucket().name;
        console.log('Default bucket:', defaultBucket);
        const bucket = admin.storage().bucket(defaultBucket);

        await bucket.deleteFiles({
          prefix: `users/${userId}/`,
        });
      } catch (storageError) {
        // Log but don't fail if storage deletion has issues
        console.warn(`Storage cleanup error for user ${userId}:`, storageError);
        Sentry.captureException(storageError);
      }

      // Send confirmation email
      await sendEmailNotification({
        from: '"Spendless" <noreply@yourapp.com>',
        to: userEmail,
        subject: 'Your account has been deleted',
        html: `
          <h2>Account Deletion Confirmation</h2>
          <p>Hello,</p>
          <p>This is a confirmation that your Spendless account and all associated data have been successfully deleted from our system.</p>
          <p>We're sorry to see you go. If you have any feedback about your experience with Spendless, please feel free to reply to this email.</p>
          <p>If you deleted your account by mistake or wish to rejoin in the future, you'll need to create a new account.</p>
          <p>Thank you for using Spendless.</p>
        `,
      });

      return {
        success: true,
        message: `Account for ${userEmail} deleted successfully.`,
        accountId: userId,
      };
    } catch (error) {
      Sentry.captureException(error);
      console.error('Error deleting account:', error);
      return {
        success: false,
        message: `${error}`,
      };
    }
  });
};
