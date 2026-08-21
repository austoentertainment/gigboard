import { Resend } from "resend";
import { createAdminClient } from "./supabase/admin";

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

  // Best-effort log for the Roster tab's Email Log — every email type
  // routes through this one function, so this is the single choke point
  // that covers all of them. A logging failure should never mask (or be
  // mistaken for) the actual send failure above.
  try {
    const admin = createAdminClient();
    await admin.from("email_log").insert({ to_email: to, subject, html, failed: !!error });
  } catch (logError) {
    console.error("Failed to write email_log row:", logError);
  }
}
