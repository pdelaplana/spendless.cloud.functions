import * as functions from 'firebase-functions';
import * as nodemailer from 'nodemailer';

export async function sendEmailNotification(email: string, downloadUrl: string) {
  // Configure nodemailer with your email service
  // Note: In production, you'd use a proper email service like SendGrid, Mailgun, etc.
  const transporter = nodemailer.createTransport({
    service: 'gmail', // Replace with your email service
    auth: {
      user: functions.config().email.user,
      pass: functions.config().email.pass,
    },
  });

  const mailOptions = {
    from: '"Your App" <noreply@yourapp.com>',
    to: email,
    subject: 'Your data export is ready',
    html: `
      <h2>Your data export is ready</h2>
      <p>You requested an export of your spending data. Your file is now ready for download.</p>
      <p><a href="${downloadUrl}">Click here to download your CSV file</a></p>
      <p>This link will expire in 7 days.</p>
    `,
  };

  return transporter.sendMail(mailOptions);
}
