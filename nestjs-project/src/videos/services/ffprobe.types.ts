/**
 * TypeScript interfaces for ffprobe JSON output.
 * Only includes fields actually used in the codebase.
 * Derived from ffprobe schema: https://ffprobe.readthedocs.io/
 */

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string | number;
  r_frame_rate?: string;
  duration?: string;
}

export interface FfprobeFormat {
  duration?: string;
  format_name?: string;
  filename?: string;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}
