import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

const DISPLAY_NAME = 'Arena 67';

/**
 * Sends login codes. Nodemailer over SMTP, grape's choice.
 *
 * With no SMTP configured the code is written to the log instead, so the app
 * can be signed into on a laptop with no mail provider. That fallback is
 * refused in production: a login code in a log file is a login code anyone
 * with log access can use, and silently degrading to that would be worse
 * than failing to start.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly log = new Logger(MailService.name);
  private readonly transport: Transporter | null;
  private readonly from: string;
  private readonly host: string | undefined;

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST')?.trim();
    this.host = host;
    this.from = formatFrom(config.get<string>('SMTP_FROM_EMAIL') ?? config.get<string>('SMTP_USER'));

    if (!host) {
      if (config.get<string>('NODE_ENV') === 'production') {
        throw new Error(
          'SMTP_HOST is not set. In production, login codes must be emailed — ' +
            'the log fallback would expose them to anyone who can read logs.',
        );
      }
      this.log.warn('SMTP_HOST unset — login codes will be printed to this log (development only).');
      this.transport = null;
      return;
    }

    const user = config.get<string>('SMTP_USER')?.trim();
    const pass = config.get<string>('SMTP_PASSWORD');
    if (user && !pass) {
      // A username with no password fails at the first send, long after boot.
      throw new Error('SMTP_USER is set but SMTP_PASSWORD is empty.');
    }

    const secure = config.get<string>('SMTP_SECURE') === 'true';
    this.transport = nodemailer.createTransport({
      host,
      port: Number(config.get<number>('SMTP_PORT') ?? (secure ? 465 : 587)),
      secure,
      // Without implicit TLS, insist on STARTTLS: a login code must never
      // cross the network in plain text because a server declined to upgrade.
      requireTLS: !secure,
      auth: user ? { user, pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  /**
   * Checks the SMTP login at boot, so a wrong password shows up in the log
   * now rather than as the first user's failed sign-in. Not fatal: a mail
   * server that is briefly down should not stop the whole backend.
   */
  onModuleInit(): void {
    if (!this.transport) return;
    this.transport
      .verify()
      .then(() => this.log.log(`SMTP ready — sending login codes via ${this.host} as ${this.from}`))
      .catch((err: Error) =>
        this.log.error(`SMTP check failed (${this.host}): ${err.message}. Login emails will fail until fixed.`),
      );
  }

  async sendLoginCode(email: string, code: string): Promise<void> {
    if (!this.transport) {
      // Deliberately loud and obvious, so it is never mistaken for a real send.
      this.log.warn(`[DEV] login code for ${email}: ${code}`);
      return;
    }

    try {
      await this.transport.sendMail({
        from: this.from,
        to: email,
        subject: `${code} is your Arena 67 code`,
        // Code first in the subject so it is readable from a notification.
        text:
          `Your Arena 67 sign-in code is ${code}.\n\n` +
          `It expires in 10 minutes and works once.\n\n` +
          `If you did not ask for this, ignore this email — nobody can sign in ` +
          `without the code.`,
        html:
          `<p>Your Arena 67 sign-in code is</p>` +
          `<p style="font-size:28px;font-weight:600;letter-spacing:4px">${code}</p>` +
          `<p>It expires in 10 minutes and works once.</p>` +
          `<p style="color:#777">If you did not ask for this, ignore this email — ` +
          `nobody can sign in without the code.</p>`,
      });
    } catch (err) {
      // The real reason goes to the log; the person gets something they can
      // act on. Same message for every address, so it reveals nothing about
      // which emails have accounts.
      this.log.error(`login email to ${maskEmail(email)} failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'We couldn’t send your code just now. Please try again in a minute.',
      );
    }
  }
}

/** Accepts "Name <addr>" as given; gives a bare address the Arena 67 name. */
function formatFrom(value: string | undefined): string {
  const v = value?.trim();
  if (!v) return `${DISPLAY_NAME} <no-reply@arena67.local>`;
  return v.includes('<') ? v : `${DISPLAY_NAME} <${v}>`;
}

/** "jo***@gmail.com" — enough to debug a delivery, not enough to harvest. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain ?? ''}`;
}
