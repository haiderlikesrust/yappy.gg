import { CLIENT_VERSION } from './config';

export function supportUrl(appeal = false, source?: string): string {
  const url = new URL('/support/', import.meta.env.DEV ? location.origin : 'https://yappy.gg');
  url.searchParams.set('client', `Web · ${CLIENT_VERSION}`);
  if (appeal) {
    url.searchParams.set('topic', 'appeal');
    try {
      const token = new URLSearchParams(new URL(source ?? '').hash.slice(1)).get('appeal');
      if (token && token.length <= 2000 && /^[A-Za-z0-9._-]+$/.test(token)) url.hash = `appeal=${token}`;
    } catch { /* A generic appeal remains available when there is no case link. */ }
  }
  return url.href;
}
