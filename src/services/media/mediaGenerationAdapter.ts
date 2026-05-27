/**
 * MediaGenerationAdapter — interface-only contract for AI-generated ad
 * creative (image ads today's planned integration, video ads next).
 *
 * Concrete adapters will live alongside this file in later tasks. For now
 * this module only declares the surface so dependent code (campaign tools,
 * content scheduler) can be typed against the abstraction.
 *
 * Maps to: Requirements 21.1, 21.3, 21.4.
 */

export type MediaKind = 'image_ad' | 'video_ad';

export interface MediaBrief {
  readonly tenantId: string;
  readonly productSku?: string;
  readonly text: string;
  readonly aspectRatio?: '1:1' | '4:5' | '9:16';
  /** Only meaningful for `video_ad` adapters; ignored by image generators. */
  readonly durationSeconds?: number;
}

export interface MediaResult {
  readonly url: string;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
}

export interface MediaGenerationAdapter {
  readonly id: MediaKind;
  generate(brief: MediaBrief): Promise<MediaResult>;
}
