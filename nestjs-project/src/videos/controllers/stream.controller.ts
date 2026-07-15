import {
  Controller,
  Get,
  Param,
  Headers,
  HttpCode,
  Response,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { StreamService } from '../services/stream.service';

/**
 * Controller for video streaming and download endpoints.
 * Implements public video streaming (HTTP 206 Range support) and downloads.
 */
@ApiTags('Videos')
@Controller('videos')
export class StreamController {
  constructor(private readonly streamService: StreamService) {}

  /**
   * Stream a video with optional Range/206 support.
   *
   * GET /videos/:public_id/stream
   * Public endpoint — no authentication required
   * Supports HTTP Range header for seeking (206 Partial Content)
   *
   * Response Headers (200):
   * - Content-Type: video/mp4
   * - Content-Length: <file size>
   * - Accept-Ranges: bytes
   *
   * Response Headers (206):
   * - Content-Type: video/mp4
   * - Content-Length: <range size>
   * - Content-Range: bytes <start>-<end>/<total>
   * - Accept-Ranges: bytes
   */
  @Get(':public_id/stream')
  @Public()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Stream a ready video with optional HTTP Range support for seeking',
  })
  @ApiResponse({
    status: 200,
    description: 'Full video stream (no Range header)',
    schema: {
      type: 'string',
      format: 'binary',
    },
  })
  @ApiResponse({
    status: 206,
    description: 'Partial video stream (Range header present)',
    schema: {
      type: 'string',
      format: 'binary',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready for streaming',
  })
  @ApiResponse({
    status: 416,
    description: 'Range not satisfiable',
  })
  async stream(
    @Param('public_id') publicId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Response() response: any, // Express Response for streaming
  ): Promise<void> {
    const result = await this.streamService.streamVideo(publicId, rangeHeader);

    // Set response status and headers
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    response.status(result.status);
    Object.entries(result.headers).forEach(([key, value]) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      response.setHeader(key, value);
    });

    // Pipe stream to response

    result.stream.pipe(response);
  }

  /**
   * Download a video file.
   *
   * GET /videos/:public_id/download
   * Public endpoint — no authentication required
   * Returns the file with Content-Disposition: attachment header
   */
  @Get(':public_id/download')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Download a video',
    description: 'Download a ready video as an attachment',
  })
  @ApiResponse({
    status: 200,
    description: 'Video file download',
    schema: {
      type: 'string',
      format: 'binary',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not ready for download',
  })
  async download(
    @Param('public_id') publicId: string,
    @Response() response: any,
  ): Promise<void> {
    const result = await this.streamService.downloadVideo(publicId);

    // Set download headers
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    response.setHeader('Content-Type', result.contentType);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    response.setHeader('Content-Length', result.contentLength);

    // Pipe stream to response

    result.stream.pipe(response);
  }
}
