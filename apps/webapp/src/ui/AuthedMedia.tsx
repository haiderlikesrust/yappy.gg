import type { ImgHTMLAttributes, VideoHTMLAttributes } from 'react';
import { useAuthedMedia } from '../lib/authedMedia';

/**
 * Drop-in <img>/<video> that can load private-bucket media: the src resolves
 * through the authed blob cache (public and external URLs pass through).
 */

export function AuthedImg(
  props: { src: string | null | undefined } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>,
) {
  const { src, ...rest } = props;
  const resolved = useAuthedMedia(src);
  return <img {...rest} src={resolved ?? undefined} />;
}

export function AuthedVideo(
  props: { src: string | null | undefined } & Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'>,
) {
  const { src, ...rest } = props;
  const resolved = useAuthedMedia(src);
  return <video {...rest} src={resolved ?? undefined} />;
}
