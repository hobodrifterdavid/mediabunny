# Testing Subtitle Extraction

This directory contains test files for the new subtitle extraction functionality.

## Quick Start

1. Build the project:
   ```bash
   npm run build
   ```

2. Test with your own video file:
   ```bash
   node test/test-subtitle-extraction.mjs path/to/video.mkv
   ```

## Test Script Options

- `--save` - Export extracted subtitles to SRT files
- `--debug` - Show detailed error information

## Example Usage

```bash
# Basic extraction (displays subtitle info)
node test/test-subtitle-extraction.mjs movie.mkv

# Extract and save subtitles to SRT files
node test/test-subtitle-extraction.mjs movie.mkv --save

# Debug mode for troubleshooting
node test/test-subtitle-extraction.mjs video.mp4 --debug
```

## What the Test Does

1. Reads the video file
2. Detects all tracks (video, audio, subtitle)
3. For each subtitle track:
   - Shows language, codec, and name
   - Displays first 5 subtitle cues as examples
   - Optionally exports to SRT format

## Supported Formats

The test works with any video format supported by MediaBunny:
- MKV/WebM files with subtitle tracks
- MP4/MOV files with subtitle tracks

## Unit Tests

See `subtitle-extraction.test.ts` for an example of how to write unit tests for this functionality. The file provides a template that can be adapted to your testing framework (Jest, Mocha, etc.). 