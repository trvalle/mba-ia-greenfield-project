import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  ForbiddenException,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtPayload } from '../../auth/auth.types';
import { UploadService } from '../services/upload.service';
import { UploadInitRequest } from '../dtos/upload-init.request';
import { UploadInitResponse } from '../dtos/upload-init.response';
import { UploadCompleteRequest } from '../dtos/upload-complete.request';
import { UploadCompleteResponse } from '../dtos/upload-complete.response';
import { ChannelsRepository } from '../../channels/repositories/channels.repository';
import { VideosRepository } from '../repositories/videos.repository';

/**
 * Controller for video upload endpoints.
 * Implements two-phase presigned PUT upload (TD-02):
 * 1. POST /videos/upload-init - Initialize upload, get presigned URL
 * 2. POST /videos/{id}/upload-complete - Verify file, enqueue processing
 */
@ApiTags('Videos')
@Controller('videos')
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly channelsRepository: ChannelsRepository,
    private readonly videosRepository: VideosRepository,
  ) {}

  /**
   * Initialize a video upload.
   *
   * Creates a draft video with a unique public_id and returns a presigned PUT URL.
   * The client can then upload the video file by making a PUT request to the returned URL.
   *
   * POST /videos/upload-init
   * Authorization: Bearer {JWT token}
   * Body: { title, channel_id, [description], [filename], [sizeBytes] }
   *
   * Response: { videoId, publicId, uploadUrl, storageKey, expiresIn }
   */
  @Post('upload-init')
  @UseGuards(JwtAuthGuard)
  @HttpCode(201)
  @ApiOperation({
    summary: 'Initialize video upload',
    description:
      'Create a draft video and get a presigned PUT URL for uploading the file',
  })
  @ApiResponse({
    status: 201,
    type: UploadInitResponse,
    description: 'Upload initialized successfully',
  })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'User does not own the channel' })
  @ApiResponse({ status: 500, description: 'Failed to initialize upload' })
  async uploadInit(
    @Body() request: UploadInitRequest,
    @Request() req: { user: JwtPayload },
  ): Promise<UploadInitResponse> {
    // Verify that user owns the requested channel
    const ownedChannel = await this.channelsRepository.findByIdAndUserId(
      request.channel_id,
      req.user.sub,
    );
    if (!ownedChannel) {
      throw new ForbiddenException(
        'User does not own this channel or channel does not exist',
      );
    }

    return this.uploadService.initializeUpload(request.channel_id, request);
  }

  /**
   * Complete a video upload.
   *
   * Verifies that the file was uploaded to storage, transitions the video to 'processing' status,
   * and enqueues a video processing job.
   *
   * POST /videos/{id}/upload-complete
   * Authorization: Bearer {JWT token}
   * Path: {id} - UUID of the video
   *
   * Response: { videoId, publicId, status, duration_seconds, thumbnail_key, createdAt }
   */
  @Post(':id/upload-complete')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Complete video upload',
    description: 'Verify the uploaded file and enqueue video processing job',
  })
  @ApiResponse({
    status: 200,
    type: UploadCompleteResponse,
    description: 'Upload completed, processing job enqueued',
  })
  @ApiResponse({ status: 400, description: 'Invalid request or video status' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Video not found' })
  @ApiResponse({ status: 403, description: 'User does not own the video' })
  @ApiResponse({
    status: 409,
    description: 'Uploaded file not found in storage',
  })
  @ApiResponse({ status: 500, description: 'Failed to complete upload' })
  async uploadComplete(
    @Param('id') videoId: string,
    @Request() req: { user: JwtPayload },
  ): Promise<UploadCompleteResponse> {
    // Load video to verify ownership
    const video = await this.videosRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new ForbiddenException('Video not found');
    }

    // Verify user owns the video's channel
    const ownedChannel = await this.channelsRepository.findByIdAndUserId(
      video.channel_id,
      req.user.sub,
    );
    if (!ownedChannel) {
      throw new ForbiddenException(
        'User does not own the channel that owns this video',
      );
    }

    return this.uploadService.completeUpload(videoId, video.channel_id);
  }
}
