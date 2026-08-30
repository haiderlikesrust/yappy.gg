import { randomUUID } from 'node:crypto';
import type { YappyBot } from '@yappydotgg/bot-sdk';
import { card, withMention } from './cards.js';
import { formatStamp } from './clock.js';
import type { Store } from './store.js';

export interface Reminder {
  id: string;
  conversationId: string;
  /** Who to ping, and what to call them. */
  userId: string;
  label: string;
  /** The message that asked, so the answer arrives as a reply to it. */
  messageId: string;
  text: string;
  dueAt: number;
  createdAt: number;
}

export interface ReminderState {
  reminders: Reminder[];
}

/** `setTimeout` silently fires *immediately* past this, which for a reminder
 *  three weeks out would be spectacularly wrong. Long waits are chained. */
const MAX_DELAY = 2_147_483_000;

/** Beyond a month, a reminder bot is the wrong tool and a calendar is right. */
export const MAX_AHEAD_MS = 30 * 86_400_000;

export class Reminders {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: Store<ReminderState>,
    private readonly bot: YappyBot,
    private readonly zone: string,
  ) {}

  /**
   * Pick up where the last process left off.
   *
   * Anything already due fires now and says so. The alternative — dropping it
   * because its moment passed while the bot was down — is the failure people
   * never forgive, and "late" is much better than "never".
   */
  async resume(): Promise<void> {
    const { reminders } = this.store.get();
    const now = Date.now();
    for (const reminder of reminders) {
      if (reminder.dueAt <= now) void this.fire(reminder, true);
      else this.schedule(reminder);
    }
    const late = reminders.filter((r) => r.dueAt <= now).length;
    console.log(`[reminders] ${reminders.length} restored${late ? `, ${late} overdue` : ''}`);
  }

  list(userId: string): Reminder[] {
    return this.store
      .get()
      .reminders.filter((r) => r.userId === userId)
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  async add(input: Omit<Reminder, 'id' | 'createdAt'>): Promise<Reminder> {
    const reminder: Reminder = { ...input, id: randomUUID(), createdAt: Date.now() };
    const state = this.store.get();
    await this.store.set({ reminders: [...state.reminders, reminder] });
    this.schedule(reminder);
    return reminder;
  }

  /**
   * Cancel, but only your own.
   *
   * The button already carries `onlyUserId`, which the server enforces at press
   * time. This is the second check, because a bot that trusts one fence is a
   * bot that stops working correctly the day that fence moves.
   */
  async cancel(id: string, byUserId: string): Promise<Reminder | null> {
    const state = this.store.get();
    const found = state.reminders.find((r) => r.id === id);
    if (!found || found.userId !== byUserId) return null;

    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);

    await this.store.set({ reminders: state.reminders.filter((r) => r.id !== id) });
    return found;
  }

  private schedule(reminder: Reminder): void {
    const existing = this.timers.get(reminder.id);
    if (existing) clearTimeout(existing);

    const wait = reminder.dueAt - Date.now();
    if (wait > MAX_DELAY) {
      // Wake up in three weeks and work out the rest from there.
      const timer = setTimeout(() => this.schedule(reminder), MAX_DELAY);
      this.timers.set(reminder.id, timer);
      return;
    }

    const timer = setTimeout(() => void this.fire(reminder, false), Math.max(0, wait));
    this.timers.set(reminder.id, timer);
  }

  private async fire(reminder: Reminder, late: boolean): Promise<void> {
    this.timers.delete(reminder.id);
    try {
      const suffix = late ? ` (late — I was restarted, this was due ${formatStamp(this.zone, new Date(reminder.dueAt))})` : '';
      const { content, entities } = withMention(
        reminder.userId,
        reminder.label,
        `${reminder.text}${suffix}`,
      );
      await this.bot.send(reminder.conversationId, {
        content,
        entities,
        replyToId: reminder.messageId,
        // Idempotent: a retry after a flaky send returns the same message
        // rather than reminding somebody twice.
        nonce: `rem_${reminder.id}`,
      });
    } catch (err) {
      console.error('[reminders] failed to deliver', reminder.id, err);
    } finally {
      const state = this.store.get();
      await this.store.set({ reminders: state.reminders.filter((r) => r.id !== reminder.id) });
    }
  }
}

/** The card that confirms one was set. */
export function confirmation(reminder: Reminder, said: string, zone: string) {
  return card('Reminder set')
    .description(reminder.text)
    .field('When', `${said} — ${formatStamp(zone, new Date(reminder.dueAt))}`)
    .build();
}
