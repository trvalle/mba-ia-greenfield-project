import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import storageConfig from '../config/storage.config';
import {
  BucketNotAccessibleException,
  FileNotFoundException,
  PresignUrlGenerationException,
  StorageException,
} from '../common/exceptions/domain.exception';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private s3Client: S3Client;

  constructor(
    private readonly configService: ConfigService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.s3Client = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpointInternal,
      credentials: {
        accessKeyId: this.config.accessKeyId!,
        secretAccessKey: this.config.secretAccessKey!,
      },
      forcePathStyle: true,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucketExists();
  }

  async ensureBucketExists(): Promise<void> {
    try {
      await this.s3Client.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
      );
      this.logger.debug(`Bucket "${this.config.bucket}" already exists`);
    } catch (error) {
      const errorCode = error?.Code || error?.name;
      if (errorCode === 'NoSuchBucket' || errorCode === 'NotFound') {
        try {
          await this.s3Client.send(
            new CreateBucketCommand({ Bucket: this.config.bucket }),
          );
          this.logger.log(
            `Bucket "${this.config.bucket}" created successfully`,
          );
        } catch (createError) {
          this.logger.error('Failed to create bucket', createError);
          throw new BucketNotAccessibleException();
        }
      } else {
        this.logger.error('Failed to check bucket', error);
        throw new BucketNotAccessibleException();
      }
    }
  }

  async generatePresignedPutUrl(
    storageKey: string,
    contentType: string = 'application/octet-stream',
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey,
        ContentType: contentType,
      });

      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: this.config.presignExpirationSeconds,
      });

      // Replace internal endpoint with public endpoint in the URL
      const presignedUrl = url.replace(
        this.config.endpointInternal!,
        this.config.endpointPublic!,
      );

      this.logger.debug(`Generated presigned PUT URL for key: ${storageKey}`);
      return presignedUrl;
    } catch (error) {
      this.logger.error(`Failed to generate presigned PUT URL`, error);
      throw new PresignUrlGenerationException(
        'Failed to generate presigned PUT URL',
      );
    }
  }

  async generatePresignedGetUrl(storageKey: string): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey,
      });

      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: this.config.presignExpirationSeconds,
      });

      // Replace internal endpoint with public endpoint in the URL
      const presignedUrl = url.replace(
        this.config.endpointInternal!,
        this.config.endpointPublic!,
      );

      this.logger.debug(`Generated presigned GET URL for key: ${storageKey}`);
      return presignedUrl;
    } catch (error) {
      this.logger.error(`Failed to generate presigned GET URL`, error);
      throw new PresignUrlGenerationException(
        'Failed to generate presigned GET URL',
      );
    }
  }

  async headObject(
    storageKey: string,
  ): Promise<{ size: number; lastModified?: Date }> {
    try {
      const response = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: storageKey,
        }),
      );

      this.logger.debug(`Head object successful for key: ${storageKey}`);
      return {
        size: response.ContentLength || 0,
        lastModified: response.LastModified,
      };
    } catch (error) {
      const errorCode = error?.Code || error?.name;
      if (errorCode === 'NotFound' || errorCode === 'NoSuchKey') {
        this.logger.debug(`Object not found for key: ${storageKey}`);
        throw new FileNotFoundException();
      }
      this.logger.error(`Failed to head object`, error);
      throw new StorageException('Failed to check object metadata');
    }
  }

  async getObject(
    storageKey: string,
    startByte?: number,
    endByte?: number,
  ): Promise<Readable> {
    try {
      const rangeHeader =
        startByte !== undefined && endByte !== undefined
          ? `bytes=${startByte}-${endByte}`
          : undefined;

      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: storageKey,
          Range: rangeHeader,
        }),
      );

      this.logger.debug(
        `Get object successful for key: ${storageKey}${rangeHeader ? ` (${rangeHeader})` : ''}`,
      );
      return response.Body as Readable;
    } catch (error) {
      const errorCode = error?.Code || error?.name;
      if (errorCode === 'NotFound' || errorCode === 'NoSuchKey') {
        this.logger.debug(`Object not found for key: ${storageKey}`);
        throw new FileNotFoundException();
      }
      this.logger.error(`Failed to get object`, error);
      throw new StorageException('Failed to download object from storage');
    }
  }

  async putObject(
    storageKey: string,
    data: Buffer | Readable | string,
  ): Promise<void> {
    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: storageKey,
          Body: data,
        }),
      );

      this.logger.debug(`Put object successful for key: ${storageKey}`);
    } catch (error) {
      this.logger.error(`Failed to put object`, error);
      throw new StorageException('Failed to upload object to storage');
    }
  }

  async deleteObject(storageKey: string): Promise<void> {
    try {
      // Note: DeleteObjectCommand doesn't throw on missing objects
      // Sending a delete request that succeeds regardless
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: storageKey,
        }),
      );

      this.logger.debug(`Delete object successful for key: ${storageKey}`);
    } catch (error) {
      this.logger.error(`Failed to delete object`, error);
      throw new StorageException('Failed to delete object from storage');
    }
  }

  formatVideoKey(
    channelId: string,
    videoId: string,
    extension: string,
  ): string {
    return `videos/channels/${channelId}/videos/${videoId}/source.${extension}`;
  }

  formatThumbnailKey(channelId: string, videoId: string): string {
    return `thumbnails/channels/${channelId}/videos/${videoId}/thumb.jpg`;
  }
}
