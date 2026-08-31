import { useRef, type ImgHTMLAttributes, type VideoHTMLAttributes } from 'react';
import { useAuthedMedia } from '../lib/authedMedia';

/**
 * Drop-in <img>/<video> that can load private-bucket media: the src resolves
 * through the authed blob cache (public and external URLs pass through).
 *
 * Each one watches its own element, so a private fetch waits until it is
 * within a screen and a half of the viewport. A room forty photos deep now
 * downloads the few you can see rather than all of them at once.
 */

export function AuthedImg(
  props: { src: string | null | undefined } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>,
) {
  const { src, ...rest } = props;
  const ref = useRef<HTMLImageElement>(null);
  const resolved = useAuthedMedia(src, ref);
  return <img ref={ref} {...rest} src={resolved ?? undefined} />;
}

export function AuthedVideo(
  props: { src: string | null | undefined } & Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'>,
) {
  const { src, ...rest } = props;
  const ref = useRef<HTMLVideoElement>(null);
  const resolved = useAuthedMedia(src, ref);
  return <video ref={ref} {...rest} src={resolved ?? undefined} />;
}
