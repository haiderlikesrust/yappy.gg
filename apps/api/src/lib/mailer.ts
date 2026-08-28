/**
 * The two letters this app sends.
 *
 * Only the words live here. Delivery is the worker's (`jobs/email.ts`): a
 * provider having a bad minute must not turn "reset my password" into a 500,
 * so the request writes the code, hands the letter to the queue and answers.
 *
 * Written to be read in a notification preview: what it is, the code, and what
 * to do if it was not you. No images, no button that has to load, nothing that
 * resembles the phishing mail somebody will eventually send in our name — one
 * short paragraph and six digits people can compare with what is on screen.
 *
 * They also invite a reply, which is only honest because the sending address
 * is a mailbox somebody reads. If that ever becomes a no-reply, take the line
 * out in the same commit — an unanswered reply to a security email is worse
 * than never having offered.
 */

export interface Letter {
  subject: string;
  /** Plain text is what actually arrives. Anything fancier is a liability here. */
  text: string;
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
  };
}
