/**
 * Outbound email — one function per email this app sends, one provider
 * behind both, reached with `fetch` and no dependency (CLAUDE.md: "Email is
 * sent by fetch to an HTTP API, not by an SMTP client library").
 *
 * PROVIDER: Brevo — https://api.brevo.com/v3/smtp/email
 *
 * Checked against the project's three requirements before picking it
 * (verified 2026-08-13; re-check before trusting this if it's been a while):
 *
 *   1. No custom domain needed. A "single sender" is verified by pasting a
 *      6-digit code emailed to that one mailbox — no DNS record required.
 *      Brevo's own docs recommend full domain authentication (SPF/DKIM/DMARC)
 *      for BULK senders, which Gmail/Yahoo have required since Feb 2024 for
 *      accounts sending 5,000+ messages/day — irrelevant at the volume of
 *      password-reset and confirmation mail this app sends.
 *   2. HTTP API: one POST, JSON in, JSON out.
 *   3. Free, no credit card: 300 emails/day, indefinitely, confirmed current.
 *
 *   Resend was rejected: without a verified domain its sender
 *   (onboarding@resend.dev) can only deliver to the Resend account's own
 *   address — useless for mail aimed at a stranger's inbox, which is the
 *   entire point of a password reset.
 *   SendGrid was rejected: its free plan was discontinued in 2025 and
 *   replaced with a 60-day trial that then requires a paid plan — not an
 *   ongoing free tier, which is what was asked for.
 *   Mailjet was the other real candidate (single sender verified by a
 *   confirmation link, no domain, HTTP API) — Brevo was chosen for the larger
 *   free allowance, 300/day vs. Mailjet's 500/month.
 *
 * SETUP
 *   1. brevo.com -> sign up (no card) -> verify one sender address (a code is
 *      emailed to it, no DNS to touch).
 *   2. Create an API key under SMTP & API -> API Keys.
 *   3. Set BREVO_API_KEY and JT_MAIL_FROM (the address you verified) in .env
 *      / your host's secrets.
 *
 * With no BREVO_API_KEY configured, every function below logs the link to
 * the console instead of sending or throwing. That is not a fallback for
 * production — it is what makes the whole password-reset flow testable with
 * no account at any provider, and how local development is meant to work.
 */

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

const isConfigured = () => Boolean(process.env.BREVO_API_KEY);

async function send({ to, subject, text, html, consoleLabel }) {
    if (!isConfigured()) {
        console.log(`\n[emailService] no BREVO_API_KEY set — ${consoleLabel}:\n${text}\n`);
        return;
    }

    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            sender: { email: process.env.JT_MAIL_FROM, name: 'JobTrail' },
            to: [{ email: to }],
            subject,
            textContent: text,
            htmlContent: html,
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`emailService: Brevo responded ${response.status}: ${body}`);
    }
}

/** @param {string} to @param {string} resetUrl valid for one hour, single use */
async function sendPasswordReset(to, resetUrl) {
    await send({
        to,
        subject: 'איפוס סיסמה ל-JobTrail',
        text:
            `כדי לאפס את הסיסמה שלך, פתחי את הקישור הבא (תקף לשעה אחת, לשימוש חד-פעמי):\n${resetUrl}\n\n` +
            'אם לא ביקשת זאת, אפשר להתעלם מהמייל הזה — שום דבר לא ישתנה בחשבון שלך.',
        html:
            `<p>כדי לאפס את הסיסמה שלך, לחצי על הקישור הבא (תקף לשעה אחת, לשימוש חד-פעמי):</p>` +
            `<p><a href="${resetUrl}">${resetUrl}</a></p>` +
            `<p>אם לא ביקשת זאת, אפשר להתעלם מהמייל הזה — שום דבר לא ישתנה בחשבון שלך.</p>`,
        consoleLabel: `password reset link for ${to}`,
    });
}

/** @param {string} to @param {string} confirmUrl one click, no form */
async function sendEmailConfirmation(to, confirmUrl) {
    await send({
        to,
        subject: 'אישור כתובת האימייל שלך ב-JobTrail',
        text: `כדי לאשר שזו כתובת האימייל שלך, פתחי את הקישור הבא:\n${confirmUrl}`,
        html: `<p>כדי לאשר שזו כתובת האימייל שלך, לחצי על הקישור הבא:</p><p><a href="${confirmUrl}">${confirmUrl}</a></p>`,
        consoleLabel: `email confirmation link for ${to}`,
    });
}

module.exports = { sendPasswordReset, sendEmailConfirmation, isConfigured };
