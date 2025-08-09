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
		lastRawTimestamp: number;
		hasWraparound: boolean;
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
				lastRawTimestamp: timestampInSeconds,
				hasWraparound: false,
			};
			this.trackTimestampInfo.set(track, timestampInfo);
		}

		// Detect timestamp wraparound - if timestamp jumps by more than 1 hour, ignore the jump
		const timeDiff = timestampInSeconds - timestampInfo.lastRawTimestamp;

		if (Math.abs(timeDiff) > 3600) {
			// Timestamp jump detected - likely a wraparound or error in the file
			// Just continue from where we were
			if (!timestampInfo.hasWraparound) {
				console.log(`[MUXER FIX] Detected timestamp discontinuity: ${timestampInfo.lastRawTimestamp}s -> ${timestampInSeconds}s (diff: ${timeDiff}s). Ignoring jumps from now on.`);
				timestampInfo.hasWraparound = true;
			}
			// Continue with a small increment from the last good timestamp
			timestampInSeconds = timestampInfo.maxTimestamp + 0.042667; // About 1 frame at 24fps
		} else if (timestampInfo.hasWraparound) {
			// After wraparound, use relative timing
			timestampInSeconds = timestampInfo.maxTimestamp + Math.max(0.001, timeDiff);
		}

		timestampInfo.lastRawTimestamp = timestampInSeconds - track.source._timestampOffset; // Store raw for next comparison

		if (timestampInSeconds < 0) {
			throw new Error(`Timestamps must be non-negative (got ${timestampInSeconds}s).`);
		}

		if (isKeyFrame) {
			timestampInfo.maxTimestampBeforeLastKeyFrame = timestampInfo.maxTimestamp;
		}

		if (timestampInSeconds < timestampInfo.maxTimestampBeforeLastKeyFrame) {
			// This shouldn't happen with our fix, but just in case
			timestampInSeconds = timestampInfo.maxTimestamp + 0.001;
		}

		timestampInfo.maxTimestamp = Math.max(timestampInfo.maxTimestamp, timestampInSeconds);

		return timestampInSeconds;
	}
}
