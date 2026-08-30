/**
 * The two letters this app sends.
 *
 * Only the words live here. Delivery is the worker's (`jobs/email.ts`): a
 * provider having a bad minute must not turn "reset my password" into a 500,
 * so the request writes the code, hands the letter to the queue and answers.
 *
 * Every letter goes out as both plain text and HTML. The text version is not a
 * fallback anybody has forgotten about — it is what shows in a notification, in
 * a watch, in a terminal client, and in Gmail when images are off — so it is
 * written first and reads on its own.
 *
 * They also invite a reply, which is only honest because the sending address is
 * a mailbox somebody reads. If that ever becomes a no-reply, take the line out
 * in the same commit — an unanswered reply to a security email is worse than
 * never having offered.
 */

export interface Letter {
  subject: string;
  /** What actually arrives in half the places this is read. Written first. */
  text: string;
  html: string;
  /**
   * Who it comes from, when that is not the default mailbox.
   *
   * Only honoured if the provider will accept it — a mailbox host generally
   * refuses a From it did not authenticate — which is why anything using this
   * also sets `replyTo` and does not depend on the From to be reachable.
   */
  from?: string;
  replyTo?: string;
}

/**
 * Why this HTML looks like 2004.
 *
 * Email clients are not browsers. Outlook renders with Word, Gmail strips most
 * of a stylesheet, and neither has heard of flexbox, grid, custom properties or
 * a web font that is not already installed. So: one table, inline styles,
 * hex colours, and nothing that has to load. The design survives being a
 * rectangle of text, because in a fair number of inboxes that is what it will
 * be.
 *
 * The wordmark is violet in both colour schemes rather than ink-or-white,
 * because half the clients that render this will not honour the dark-mode
 * block below — and a masthead that disappears into the background on the one
 * email people were told to be suspicious of is the wrong thing to get clever
 * about.
 */
const BG = '#f4f2fb';
const CARD = '#ffffff';
const INK = '#191627';
const MUTED = '#6b6880';
const VIOLET = '#8b7cff';
const HAIRLINE = '#e8e5f5';
/** The tongue. The one warm thing in the palette, and the mark people know. */
const YELLOW = '#ffd84a';
/**
 * The logo, from the site rather than an attachment.
 *
 * Most clients block remote images until the reader says otherwise, so this
 * is never load-bearing: the alt text is the wordmark, sized and coloured so a
 * blocked image still reads as "yappy" rather than as a broken tile.
 */
const LOGO = 'https://yappy.gg/icon.png';

/** Space Grotesk if the reader happens to have it; otherwise the same shapes. */
const DISPLAY = "'Space Grotesk', 'DM Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const BODY_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', ui-monospace, Menlo, Consolas, 'Liberation Mono', monospace";

interface Shell {
  /** The line under the wordmark. */
  heading: string;
  /** A code to display as the hero, for the letters that carry one. */
  code?: string;
  minutes?: number;
  /** Used instead of the code box: paragraphs, in order. */
  body?: string[];
  /** The "if this was not you" paragraph, already sentence-cased. */
  reassurance: string;
  /** Shown greyed at the bottom, under a rule. */
  footer: string;
  /** One line of preview text, which clients show next to the subject. */
  preheader: string;
}

function shell(s: Shell): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${s.heading}</title>
    <style>
      /* Honoured by Apple Mail and iOS; ignored elsewhere, which is why every
         colour below is also set inline. */
      @media (prefers-color-scheme: dark) {
        .page { background: #0f0d18 !important; }
        .card { background: #191627 !important; border-color: #2a2640 !important; }
        .ink { color: #f2f0fa !important; }
        .muted { color: #a7a3bd !important; }
        .codebox { background: #221e35 !important; border-color: #3a3457 !important; }
      }
    </style>
  </head>
  <body class="page" style="margin:0;padding:0;background:${BG};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${s.preheader}</div>
    <table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
            <tr>
              <td align="left" style="padding:0 4px 18px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding-right:10px;vertical-align:middle;">
                      <img src="${LOGO}" width="34" height="34" alt="yappy"
                           style="display:block;width:34px;height:34px;border:0;border-radius:10px;font-family:${DISPLAY};font-size:17px;font-weight:700;color:${VIOLET};" />
                    </td>
                    <td style="vertical-align:middle;">
                      <span style="font-family:${DISPLAY};font-size:26px;font-weight:700;color:${VIOLET};letter-spacing:-0.02em;">yappy<span style="color:${YELLOW};">.</span></span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td class="card" style="background:${CARD};border:1px solid ${HAIRLINE};border-radius:18px;padding:32px 28px;">
                <div class="ink" style="font-family:${DISPLAY};font-size:19px;font-weight:600;color:${INK};margin:0 0 6px;">${s.heading}</div>
                ${
                  s.code
                    ? `<div class="muted" style="font-family:${BODY_FONT};font-size:14px;line-height:21px;color:${MUTED};margin:0 0 22px;">
                  Enter this code in the app. It works once, for the next ${s.minutes} minutes.
                </div>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td class="codebox" align="center" style="background:${BG};border:1px solid ${HAIRLINE};border-radius:14px;padding:18px 12px;">
                      <span class="ink" style="font-family:${MONO};font-size:32px;font-weight:600;letter-spacing:10px;color:${INK};">${s.code}</span>
                    </td>
                  </tr>
                </table>`
                    : (s.body ?? [])
                        .map(
                          (line) =>
                            `<div class="ink" style="font-family:${BODY_FONT};font-size:14px;line-height:22px;color:${INK};margin:0 0 14px;">${line}</div>`,
                        )
                        .join('')
                }

                <div class="muted" style="font-family:${BODY_FONT};font-size:13px;line-height:20px;color:${MUTED};margin:24px 0 0;">
                  ${s.reassurance}
                </div>

                <div style="border-top:1px solid ${HAIRLINE};margin:22px 0 0;padding:16px 0 0;">
                  <div class="muted" style="font-family:${BODY_FONT};font-size:13px;line-height:20px;color:${MUTED};">${s.footer}</div>
                </div>
              </td>
            </tr>
            <tr>
              <td align="left" style="padding:16px 4px 0;">
                <span class="muted" style="font-family:${BODY_FONT};font-size:12px;color:${MUTED};">yappy.gg — back to the group.</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function verifyEmail(code: string, minutes: number): Letter {
  return {
    subject: `${code} is your yappy verification code`,
    text: [
      `Your yappy verification code is ${code}.`,
      '',
      `It works for the next ${minutes} minutes, once.`,
      '',
      'If you did not ask to verify an address, someone typed yours by mistake.',
      'Nothing has happened to your account and you can ignore this.',
      '',
      'This address is read by a person — replying works.',
    ].join('\n'),
    html: shell({
      heading: 'Verify your email',
      code,
      minutes,
      preheader: `Your verification code is ${code}.`,
      reassurance:
        'If you did not ask to verify an address, someone typed yours by mistake. Nothing has happened to your account and you can ignore this.',
      footer: 'This address is read by a person — replying works.',
    }),
  };
}

/**
 * Somebody has been suspended, and is being told so.
 *
 * The one letter here that is not about a code, and the one people will read
 * most carefully. It says what happened, when it ends, what staff wrote down,
 * and how to argue with it — in that order, because those are the four things
 * somebody in this position wants and no other order gets read.
 *
 * The reason is the note the staff member typed. It is shown verbatim, which
 * is worth knowing while typing one: it is not an internal remark.
 *
 * From support@, not the address the codes come from, and with a Reply-To to
 * match. A suspension notice that cannot be replied to is not a notice, it is
 * a wall — and the appeal is the whole reason to send this rather than let
 * somebody discover it by being refused at the door.
 */
export function suspensionEmail(input: {
  reason: string | null;
  until: Date | null;
  supportAddress: string;
  from?: string;
}): Letter {
  const ends = input.until
    ? `Your account is suspended until ${input.until.toUTCString().replace(' GMT', ' UTC')}.`
    : 'Your account is suspended.';
  const reason = input.reason?.trim() ? `What was recorded: ${input.reason.trim()}` : null;

  return {
    subject: 'Your yappy account has been suspended',
    from: input.from,
    replyTo: input.supportAddress,
    text: [
      ends,
      "",
      ...(reason ? [reason, ""] : []),
      'While it lasts you cannot sign in or post. Nothing has been deleted:',
      'your account, messages and groups are all still there, and everything',
      'works again by itself when the suspension ends.',
      "",
      `If you think this is wrong, reply to this message. It reaches ${input.supportAddress},`,
      'a person reads it, and saying what you think happened is the fastest way',
      'to have it looked at again.',
    ].join("\n"),
    html: shell({
      heading: 'Your account has been suspended',
      preheader: ends,
      body: [
        ends,
        ...(reason ? [reason] : []),
        'While it lasts you cannot sign in or post. Nothing has been deleted: your account, messages and groups are all still there, and everything works again by itself when the suspension ends.',
      ],
      reassurance: `If you think this is wrong, reply to this message. It reaches ${input.supportAddress}, a person reads it, and saying what you think happened is the fastest way to have it looked at again.`,
      footer: 'You are receiving this because it is about your account, not because of any setting.',
    }),
  };
}

export function resetEmail(code: string, minutes: number): Letter {
  return {
    subject: `${code} is your yappy password reset code`,
    text: [
      `Your yappy password reset code is ${code}.`,
      '',
      `It works for the next ${minutes} minutes, once. Enter it in the app, or at`,
      'https://yappy.gg, to set a new password.',
      '',
      'If you did not ask for this, ignore it: the code is useless on its own and',
      'your password has not changed. Somebody may have typed your address by',
      'mistake, so it is worth checking the address on your account is still yours.',
      '',
      'Worried, or it keeps happening? Reply to this message — a person reads it.',
    ].join('\n'),
    html: shell({
      heading: 'Reset your password',
      code,
      minutes,
      preheader: `Your password reset code is ${code}.`,
      reassurance:
        'If you did not ask for this, ignore it: the code is useless on its own and your password has not changed. Somebody may have typed your address by mistake, so it is worth checking that the address on your account is still yours.',
      footer: 'Worried, or does this keep happening? Reply to this message — a person reads it.',
    }),
  };
}
