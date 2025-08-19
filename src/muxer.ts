/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AsyncMutex } from './misc';
import { Output, OutputAudioTrack, OutputSubtitleTrack, OutputTrack, OutputVideoTrack } from './output';
import { EncodedPacket } from './packet';
import { SubtitleCue, SubtitleMetadata } from './subtitles';

export abstract class Muxer {
	output: Output;
	mutex = new AsyncMutex();

	/**
	 * This field is used to synchronize multiple MediaStreamTracks. They use the same time coordinate system across
	 * tracks, and to ensure correct audio-video sync, we must use the same offset for all of them. The reason an offset
	 * is needed at all is because the timestamps typically don't start at zero.
	 */
	firstMediaStreamTimestamp: number | null = null;

	constructor(output: Output) {
		this.output = output;
	}

	abstract start(): Promise<void>;
	abstract getMimeType(): Promise<string>;
	abstract addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata
	): Promise<void>;
	abstract addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata
	): Promise<void>;
	abstract addSubtitleCue(track: OutputSubtitleTrack, cue: SubtitleCue, meta?: SubtitleMetadata): Promise<void>;
	abstract finalize(): Promise<void>;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	onTrackClose(track: OutputTrack) {}

	private trackTimestampInfo = new WeakMap<OutputTrack, {
		maxTimestamp: number;
		maxTimestampBeforeLastKeyFrame: number;
	}>();

	protected validateAndNormalizeTimestamp(track: OutputTrack, timestampInSeconds: number, isKeyFrame: boolean) {
		timestampInSeconds += track.source._timestampOffset;

		let timestampInfo = this.trackTimestampInfo.get(track);
		if (!timestampInfo) {
			if (!isKeyFrame) {
				throw new Error('First frame must be a key frame.');
			}

			timestampInfo = {
				maxTimestamp: timestampInSeconds,
				maxTimestampBeforeLastKeyFrame: timestampInSeconds,
			};
			this.trackTimestampInfo.set(track, timestampInfo);
		}

		if (timestampInSeconds < 0) {
			throw new Error(`Timestamps must be non-negative (got ${timestampInSeconds}s).`);
		}

		// Handle potential timestamp wraparound or reset (similar to FFmpeg)
		// If we detect a large backwards jump at a keyframe, treat it as a reset
		const WRAPAROUND_THRESHOLD = 3600; // 1 hour threshold for detecting potential wraparound
		
		if (isKeyFrame) {
			const timeDiff = timestampInfo.maxTimestamp - timestampInSeconds;
			
			// If there's a large backwards jump at a keyframe, allow it (potential wraparound or reset)
			if (timeDiff > WRAPAROUND_THRESHOLD) {
				console.warn(
					`Large timestamp jump detected at keyframe: ${timestampInfo.maxTimestamp}s -> ${timestampInSeconds}s. ` +
					`Treating as timestamp reset/wraparound.`
				);
				// Reset the timestamp tracking for this new segment
				timestampInfo.maxTimestamp = timestampInSeconds;
				timestampInfo.maxTimestampBeforeLastKeyFrame = timestampInSeconds;
				return timestampInSeconds;
			}
			
			timestampInfo.maxTimestampBeforeLastKeyFrame = timestampInfo.maxTimestamp;
		}

		// For non-keyframes or small jumps, maintain the original validation
		// but only within the current "run" (between keyframes)
		if (!isKeyFrame && timestampInSeconds < timestampInfo.maxTimestampBeforeLastKeyFrame) {
			throw new Error(
				`Timestamps cannot be smaller than the highest timestamp of the previous run (a run begins with a`
				+ ` key frame and ends right before the next key frame). Got ${timestampInSeconds}s, but highest`
				+ ` timestamp is ${timestampInfo.maxTimestampBeforeLastKeyFrame}s.`,
			);
		}

		timestampInfo.maxTimestamp = Math.max(timestampInfo.maxTimestamp, timestampInSeconds);

		return timestampInSeconds;
	}
}
