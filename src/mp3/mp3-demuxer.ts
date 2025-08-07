/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec } from '../codec';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrack, InputAudioTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { assert, binarySearchExact, binarySearchLessOrEqual, last, UNDETERMINED_LANGUAGE } from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { FrameHeader, getXingOffset, INFO, XING } from './mp3-misc';
import { Mp3Reader } from './mp3-reader';

type Sample = {
	timestamp: number;
	duration: number;
	dataStart: number;
	dataSize: number;
};

export class Mp3Demuxer extends Demuxer {
	reader: Mp3Reader;

	metadataPromise: Promise<void> | null = null;
	firstFrameHeader: FrameHeader | null = null;
	allSamples: Sample[] = [];

	tracks: InputAudioTrack[] = [];

	constructor(input: Input) {
		super(input);

		this.reader = new Mp3Reader(input._mainReader);
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			const fileSize = await this.input.source.getSize();
			this.reader.fileSize = fileSize;

			// Just load the entire file. Primitive, but the only way to actually ensure 100% correct timestamps.
			// Random access in MP3 can be flaky and unreliable.
			await this.reader.reader.loadRange(0, fileSize);

			const id3Tag = this.reader.readId3();
			if (id3Tag) {
				this.reader.pos += id3Tag.size;
			}

			let nextTimestampInSamples = 0;

			// Let's read all samples
			while (true) {
				const header = this.reader.readNextFrameHeader();
				if (!header) {
					break;
				}

				const xingOffset = getXingOffset(header.mpegVersionId, header.channel);
				this.reader.pos = header.startPos + xingOffset;
				const word = this.reader.readU32();
				const isXing = word === XING || word === INFO;

				this.reader.pos = header.startPos + header.totalSize - 1; // -1 in case the frame is 1 byte too short

				if (isXing) {
					// There's no actual audio data in this frame, so let's skip it
					continue;
				}

				if (!this.firstFrameHeader) {
					this.firstFrameHeader = header;
				}

				const sampleDuration = header.audioSamplesInFrame / header.sampleRate;
				const sample: Sample = {
					timestamp: nextTimestampInSamples / header.sampleRate,
					duration: sampleDuration,
					dataStart: header.startPos,
					dataSize: header.totalSize,
				};

				this.allSamples.push(sample);
				nextTimestampInSamples += header.audioSamplesInFrame;
			}

			if (!this.firstFrameHeader) {
				throw new Error('No MP3 frames found.');
			}

			this.tracks = [new InputAudioTrack(new Mp3AudioTrackBacking(this))];
		})();
	}

	async getMimeType() {
		return 'audio/mpeg';
	}

	async getTracks() {
		await this.readMetadata();
		return this.tracks;
	}

	async computeDuration() {
		await this.readMetadata();

		const lastSample = last(this.allSamples);
		assert(lastSample);

		return lastSample.timestamp + lastSample.duration;
	}
}

class Mp3AudioTrackBacking implements InputAudioTrackBacking {
	constructor(public demuxer: Mp3Demuxer) {}

	getId() {
		return 1;
	}

	async getFirstTimestamp() {
		return 0;
	}

	getTimeResolution() {
		assert(this.demuxer.firstFrameHeader);
		return this.demuxer.firstFrameHeader.sampleRate / this.demuxer.firstFrameHeader.audioSamplesInFrame;
	}

	computeDuration() {
		return this.demuxer.computeDuration();
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getLanguageBCP47() {
		// MP3 files don't have language metadata
		return null;
	}

	getName() {
		// MP3 files don't have track names in metadata
		return null;
	}

	isDefault() {
		return true; // Single track is always default
	}

	isForced() {
		return false;
	}

	getDefaultDuration() {
		// MP3 frame duration depends on bitrate and sample rate
		return null;
	}

	getCodecDelay() {
		return 0;
	}

	getSeekPreRoll() {
		return 0;
	}

	getCodec(): AudioCodec {
		return 'mp3';
	}

	getCodecId() {
		return 'mp3';
	}

	getNumberOfChannels() {
		assert(this.demuxer.firstFrameHeader);
		return this.demuxer.firstFrameHeader.channel === 3 ? 1 : 2;
	}

	getSampleRate() {
		assert(this.demuxer.firstFrameHeader);
		return this.demuxer.firstFrameHeader.sampleRate;
	}

	getBitDepth() {
		// MP3 is a lossy codec, bit depth not applicable
		return null;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		assert(this.demuxer.firstFrameHeader);

		return {
			codec: 'mp3',
			numberOfChannels: this.demuxer.firstFrameHeader.channel === 3 ? 1 : 2,
			sampleRate: this.demuxer.firstFrameHeader.sampleRate,
		};
	}

	getPacketAtIndex(sampleIndex: number, options: PacketRetrievalOptions) {
		if (sampleIndex === -1) {
			return null;
		}

		const rawSample = this.demuxer.allSamples[sampleIndex];
		if (!rawSample) {
			return null;
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			this.demuxer.reader.pos = rawSample.dataStart;
			data = this.demuxer.reader.readBytes(rawSample.dataSize);
		}

		return new EncodedPacket(
			data,
			'key',
			rawSample.timestamp,
			rawSample.duration,
			sampleIndex,
			rawSample.dataSize,
		);
	}

	async getFirstPacket(options: PacketRetrievalOptions) {
		return this.getPacketAtIndex(0, options);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const sampleIndex = binarySearchExact(
			this.demuxer.allSamples,
			packet.timestamp,
			x => x.timestamp,
		);
		if (sampleIndex === -1) {
			throw new Error('Packet was not created from this track.');
		}

		return this.getPacketAtIndex(sampleIndex + 1, options);
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		const index = binarySearchLessOrEqual(
			this.demuxer.allSamples,
			timestamp,
			x => x.timestamp,
		);
		return this.getPacketAtIndex(index, options);
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}
