import * as nodemailer from 'nodemailer';
import mailGunTransport from 'nodemailer-mailgun-transport';

export async function sendEmailNotification(email: string, downloadUrl: string) {
  // Configure Mailgun transport
  const mailgunConfig = {
    auth: {
      domain: process.env.MAILGUN_DOMAIN || '',
      apiKey: process.env.MAILGUN_API_KEY || '',
    },
  };

  // Create the transporter with Mailgun configuration
  const transporter = nodemailer.createTransport(mailGunTransport(mailgunConfig));

  const mailOptions = {
    from: '"Spendless" <noreply@yourapp.com>',
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
