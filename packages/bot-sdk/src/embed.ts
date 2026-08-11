import type { Button, ButtonStyle, ComponentRow, Embed, EmbedField } from './types.js';

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

export function button(
  customId: string,
  label: string,
  style: ButtonStyle = 'secondary',
  extra: Partial<Pick<Button, 'disabled' | 'onlyUserId'>> = {},
): Button {
  return { type: 'button', customId, label, style, ...extra };
}

/** Up to five buttons. Beyond that, use a second row. */
export function row(...buttons: Button[]): ComponentRow {
  return { type: 'row', components: buttons.slice(0, 5) };
}
