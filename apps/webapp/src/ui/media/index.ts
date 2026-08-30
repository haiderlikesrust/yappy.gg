/**
 * The media layer, in one import for the shell:
 *
 *   import {
 *     useAttachmentUpload, AttachmentTray, MediaViewer,
 *     GifPicker, StickerPicker, useFileDrop, filesFromClipboard, DropOverlay,
 *   } from './media';
 */

export {
  useAttachmentUpload,
  validateFile,
  type AttachmentUpload,
  type UploadItem,
  type UploadStatus,
  type MediaDto,
} from './useAttachmentUpload';
export { AttachmentTray } from './AttachmentTray';
export { MediaViewer } from './MediaViewer';
export { GifPicker, type GifPayload } from './GifPicker';
export {
  StickerPicker,
  type StickerPick,
  type InstalledSticker,
  type InstalledStickerPack,
} from './StickerPicker';
export { useFileDrop, filesFromClipboard } from './useFileDrop';
export { DropOverlay } from './DropOverlay';
