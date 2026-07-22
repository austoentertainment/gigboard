import { Resend } from "resend";

export async function sendEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`RESEND_API_KEY not set — skipping email "${subject}" to ${to}`);
    return;
  }
  const from = process.env.RESEND_FROM_EMAIL || "Austo Gig Board <board@austoentertainment.com>";
  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({ from, to, subject, html });
  if (error) {
    console.error(`Failed to send email "${subject}" to ${to}:`, error);
  }
}
