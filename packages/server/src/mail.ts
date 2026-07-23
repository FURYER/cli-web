/**
 * Optional SMTP alerts (Yandex / any SMTP). No-op if SMTP_* not configured.
 */
import nodemailer from "nodemailer";

function parseList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function alertEmailConfigured(): boolean {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const to = parseList(process.env.ALERT_EMAIL_TO);
  return Boolean(host && user && pass && to.length);
}

export async function sendAlertEmail(input: {
  subject: string;
  text: string;
}): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!alertEmailConfigured()) {
    return { ok: false, skipped: true };
  }

  const host = process.env.SMTP_HOST!.trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER!.trim();
  const pass = process.env.SMTP_PASS!.trim();
  const secure =
    (process.env.SMTP_SECURE ?? (port === 465 ? "1" : "0")).trim() !== "0";
  const from =
    process.env.ALERT_EMAIL_FROM?.trim() ||
    process.env.SMTP_FROM?.trim() ||
    user;
  const to = parseList(process.env.ALERT_EMAIL_TO);

  try {
    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
    await transport.sendMail({
      from,
      to: to.join(", "),
      subject: input.subject,
      text: input.text,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[mail] send failed:", message);
    return { ok: false, error: message };
  }
}
