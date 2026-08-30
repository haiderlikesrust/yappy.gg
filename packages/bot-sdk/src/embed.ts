import { resolve, type PermissionInput } from './perms.js';
import type {
  Button,
  ButtonStyle,
  ChartKind,
  ChartPoint,
  ComponentRow,
  Embed,
  EmbedChart,
  EmbedField,
} from './types.js';

/**
 * A small builder for cards.
 *
 * Exists mostly to encode the two limits that are otherwise learned by having
 * a card come out wrong on somebody's phone.
 *
 * **Prefer fields over one long description.** Clients cap an embed's
 * description at eight lines and ellipsise the rest, so a stats card written as
 * one block gets cut in half. The same content as fields is not capped, and it
 * lays out better besides. If you are porting a card from another platform,
 * this is the change to make.
 *
 * **Keep button labels short.** Two buttons in a row share a 300pt card and
 * long labels stack full width instead of sitting side by side. That is not a
 * failure, but if you wanted a neat pair, keep each label under about fourteen
 * characters.
 *
 * **A chart is a picture of numbers you also write as fields.** Clients that
 * have never heard of `chart` still render the title and fields. Pie and donut
 * keep eight slices; everything else keeps twenty-four.
 */
export class EmbedBuilder {
  private readonly embed: Embed = { fields: [] };

  title(text: string): this {
    this.embed.title = text;
    return this;
  }

  description(text: string): this {
    this.embed.description = text;
    return this;
  }

  url(href: string): this {
    this.embed.url = href;
    return this;
  }

  /** `#RRGGBB`. Renders as the accent bar down the card's left edge. */
  color(hex: string): this {
    this.embed.color = hex;
    return this;
  }

  author(name: string, iconUrl?: string): this {
    this.embed.author = { name, iconUrl: iconUrl ?? null };
    return this;
  }

  /** @param inline sit two side by side. Use it for short stat pairs. */
  field(name: string, value: string, inline = false): this {
    (this.embed.fields ??= []).push({ name, value, inline });
    return this;
  }

  fields(list: EmbedField[]): this {
    (this.embed.fields ??= []).push(...list);
    return this;
  }

  image(url: string): this {
    this.embed.image = { url };
    return this;
  }

  thumbnail(url: string): this {
    this.embed.thumbnail = { url };
    return this;
  }

  /**
   * An inline chart. Two forms:
   *
   * ```ts
   * .chart('bar', [{ label: 'Now', value: 12_000 }, { label: 'ATH', value: 40_000 }])
   * .chart({ kind: 'line', points })
   * ```
   *
   * Non-finite values are dropped. Fewer than two points after that means no
   * chart, rather than a card the server refuses.
   */
  chart(kind: ChartKind, points: ChartPoint[]): this;
  chart(chart: EmbedChart): this;
  chart(kindOrChart: ChartKind | EmbedChart, points?: ChartPoint[]): this {
    const raw: EmbedChart =
      typeof kindOrChart === 'string' ? { kind: kindOrChart, points: points ?? [] } : kindOrChart;
    const max = raw.kind === 'pie' || raw.kind === 'donut' ? 8 : 24;
    const cleaned = raw.points
      .filter((p) => Number.isFinite(p.value))
      .slice(0, max)
      .map((p) => ({ label: String(p.label ?? '').trim().slice(0, 16), value: p.value }));
    if (cleaned.length >= 2) this.embed.chart = { kind: raw.kind, points: cleaned };
    return this;
  }

  footer(text: string, iconUrl?: string): this {
    this.embed.footer = { text, iconUrl: iconUrl ?? null };
    return this;
  }

  timestamp(iso: string = new Date().toISOString()): this {
    this.embed.timestamp = iso;
    return this;
  }

  build(): Embed {
    return this.embed;
  }
}

export interface ButtonOptions {
  disabled?: boolean;
  onlyUserId?: string | null;
  /**
   * Bits the *presser* must hold. A name (`'BAN_MEMBERS'`), a list of names,
   * or a decimal string already on the wire. The server checks the presser,
   * never the bot — that is the whole point.
   */
  requiredPermissions?: PermissionInput;
}

export function button(
  customId: string,
  label: string,
  style: ButtonStyle = 'secondary',
  extra: ButtonOptions = {},
): Button {
  const { requiredPermissions, ...rest } = extra;
  return {
    type: 'button',
    customId,
    label,
    style,
    ...rest,
    ...(requiredPermissions !== undefined
      ? { requiredPermissions: resolve(requiredPermissions) }
      : {}),
  };
}

/** Up to five buttons. Beyond that, use a second row. */
export function row(...buttons: Button[]): ComponentRow {
  return { type: 'row', components: buttons.slice(0, 5) };
}
