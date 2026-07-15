import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  bucket: process.env.S3_BUCKET || 'streamtube',
  region: process.env.S3_REGION || 'us-east-1',
  endpointInternal: process.env.S3_ENDPOINT_INTERNAL,
  endpointPublic: process.env.S3_ENDPOINT_PUBLIC,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  presignExpirationSeconds: parseInt(
    process.env.PRESIGN_EXPIRATION_SECONDS || '3600',
    10,
  ),
}));
