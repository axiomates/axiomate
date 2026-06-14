// Types
export type {
  ClipboardImageResult,
  ImageMetadata,
  SharpInstance,
  SharpFunction,
  SharpCreator,
  SharpCreatorOptions,
  NativeModule,
} from './types.js'

// Sharp image processing
export { getImageProcessor, getImageCreator, sharp, sharpAsync } from './sharp.js'

// Clipboard image access
export {
  hasClipboardImage,
  readClipboardImage,
  hasClipboardImageAsync,
  readClipboardImageAsync,
  readClipboardFilePaths,
  getNativeModule,
} from './clipboard.js'
