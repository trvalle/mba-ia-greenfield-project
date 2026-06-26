import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  },
  queueNames: {
    videoProcessing: 'video-processing',
  },
  jobNames: {
    processVideo: 'process-video',
  },
}));
