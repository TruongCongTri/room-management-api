/**
 * Tiện ích dựng URL đối tượng:
 *  - Public: CDN (STORAGE_PUBLIC_BASE_URL) → endpoint tùy biến (MinIO / Supabase S3, path-style) → AWS virtual-hosted.
 *  - Private: luôn dùng Presigned GET có thời hạn ngắn (S3StorageService.generatePresignedDownloadUrl).
 */
export interface PublicUrlSettings {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

export function buildPublicObjectUrl(settings: PublicUrlSettings, key: string): string {
  const encodedKey = encodeKey(key);

  if (settings.publicBaseUrl) {
    return `${settings.publicBaseUrl.replace(/\/+$/, '')}/${encodedKey}`;
  }

  if (settings.endpoint) {
    const endpoint = settings.endpoint.replace(/\/+$/, '');
    if (settings.forcePathStyle !== false) {
      return `${endpoint}/${settings.bucket}/${encodedKey}`;
    }
    const url = new URL(endpoint);
    return `${url.protocol}//${settings.bucket}.${url.host}/${encodedKey}`;
  }

  return `https://${settings.bucket}.s3.${settings.region}.amazonaws.com/${encodedKey}`;
}
