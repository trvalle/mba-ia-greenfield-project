import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { VideosService } from '../services/videos.service';
import { VideoMetadataResponse } from '../dtos/video-metadata.response';

/**
 * Controller for public video read endpoints.
 *
 * GET /videos/:public_id — video metadata (any status; clients poll this
 * after upload-complete to track processing).
 */
@ApiTags('Videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Get(':public_id')
  @Public()
  @ApiOperation({
    summary: 'Get video metadata',
    description:
      'Public metadata for a video by its public_id, including lifecycle status, duration, thumbnail URL and channel summary',
  })
  @ApiResponse({
    status: 200,
    type: VideoMetadataResponse,
    description: 'Video metadata',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
  })
  async getMetadata(
    @Param('public_id') publicId: string,
  ): Promise<VideoMetadataResponse> {
    return this.videosService.getMetadata(publicId);
  }
}
