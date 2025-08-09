/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	AUDIO_CODECS,
	AudioCodec,
	getFirstEncodableVideoCodec,
	getEncodableAudioCodecs,
	NON_PCM_AUDIO_CODECS,
	Quality,
	QUALITY_HIGH,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import { Input } from './input';
import { InputAudioTrack, InputTrack, InputVideoTrack } from './input-track';
import {
	AudioSampleSink,
	CanvasSink,
	EncodedPacketSink,
	VideoSampleSink,
} from './media-sink';
import {
	AudioEncodingConfig,
	AudioSource,
	EncodedVideoPacketSource,
	EncodedAudioPacketSource,
	VideoEncodingConfig,
	VideoSource,
	VideoSampleSource,
	AudioSampleSource,
} from './media-source';
import { assert, clamp, normalizeRotation, promiseWithResolvers, Rotation } from './misc';
import { Output, TrackType } from './output';
import { EncodedPacket } from './packet';
import { AudioSample, VideoSample } from './sample';

/**
 * The options for media file conversion.
 * @public
 */
export type ConversionOptions = {
	/** The input file. */
	input: Input;
	/** The output file. */
	output: Output;

	/** Video-specific options. */
	video?: {
		/** If true, all video tracks will be discarded and will not be present in the output. */
		discard?: boolean;
		/**
		 * The desired width of the output video in pixels, defaulting to the video's natural display width. If height
		 * is not set, it will be deduced automatically based on aspect ratio.
		 */
		width?: number;
		/**
		 * The desired height of the output video in pixels, defaulting to the video's natural display height. If width
		 * is not set, it will be deduced automatically based on aspect ratio.
		 */
		height?: number;
		/**
		 * The fitting algorithm in case both width and height are set.
		 *
		 * - 'fill' will stretch the image to fill the entire box, potentially altering aspect ratio.
		 * - 'contain' will contain the entire image within the box while preserving aspect ratio. This may lead to
		 * letterboxing.
		 * - 'cover' will scale the image until the entire box is filled, while preserving aspect ratio.
		 */
		fit?: 'fill' | 'contain' | 'cover';
		/**
		 * The angle in degrees to rotate the input video by, clockwise. Rotation is applied before resizing. This
		 * rotation is _in addition to_ the natural rotation of the input video as specified in input file's metadata.
		 */
		rotate?: Rotation;
		/**
		 * The desired frame rate of the output video, in hertz. If not specified, the original input frame rate will
		 * be used (which may be variable).
		 */
		frameRate?: number;
		/** The desired output video codec. */
		codec?: VideoCodec;
		/** The desired bitrate of the output video. */
		bitrate?: VideoEncodingConfig['bitrate'];
		/** When true, video will always be re-encoded instead of directly copying over the encoded samples. */
		forceTranscode?: boolean;
	};

	/** Audio-specific options. */
	audio?: {
		/** If true, all audio tracks will be discarded and will not be present in the output. */
		discard?: boolean;
		/** The desired channel count of the output audio. */
		numberOfChannels?: number;
		/** The desired sample rate of the output audio, in hertz. */
		sampleRate?: number;
		/** The desired output audio codec. */
		codec?: AudioCodec;
		/** The desired bitrate of the output audio. */
		bitrate?: AudioEncodingConfig['bitrate'];
		/** When true, audio will always be re-encoded instead of directly copying over the encoded samples. */
		forceTranscode?: boolean;
	};

	/** Options to trim the input file. */
	trim?: {
		/** The time in the input file in seconds at which the output file should start. Must be less than `end`.  */
		start: number;
		/** The time in the input file in seconds at which the output file should end. Must be greater than `start`. */
		end: number;
	};

	/** Options to filter tracks. */
	tracks?: {
		/** Specific track indices to include (0-based). */
		indices?: number[];
		/** If true, only audio tracks will be included. */
		audioOnly?: boolean;
	};
};

const FALLBACK_NUMBER_OF_CHANNELS = 2;
const FALLBACK_SAMPLE_RATE = 48000;

/**
 * Represents a media file conversion process, used to convert one media file into another. In addition to conversion,
 * this class can be used to resize and rotate video, resample audio, drop tracks, or trim to a specific time range.
 * @public
 */
export class Conversion {
	/** The input file. */
	readonly input: Input;
	/** The output file. */
	readonly output: Output;

	/** @internal */
	_options: ConversionOptions;
	/** @internal */
	_startTimestamp: number;
	/** @internal */
	_endTimestamp: number;

	/** @internal */
	_addedCounts: Record<TrackType, number> = {
		video: 0,
		audio: 0,
		subtitle: 0,
	};

	/** @internal */
	_totalTrackCount = 0;

	/** @internal */
	_trackPromises: Promise<void>[] = [];

	/** @internal */
	_started: Promise<void>;
	/** @internal */
	_start: () => void;
	/** @internal */
	_executed = false;

	/** @internal */
	_synchronizer = new TrackSynchronizer();

	/** @internal */
	_totalDuration: number | null = null;
	/** @internal */
	_maxTimestamps = new Map<number, number>(); // Track ID -> timestamp

	/** @internal */
	_canceled = false;

	/**
	 * A callback that is fired whenever the conversion progresses. Returns a number between 0 and 1, indicating the
	 * completion of the conversion. Note that a progress of 1 doesn't necessarily mean the conversion is complete;
	 * the conversion is complete once `execute` resolves.
	 *
	 * In order for progress to be computed, this property must be set before `execute` is called.
	 */
	onProgress?: (progress: number) => unknown = undefined;
	/** @internal */
	_computeProgress = false;
	/** @internal */
	_lastProgress = 0;

	/** The list of tracks that are included in the output file. */
	readonly utilizedTracks: InputTrack[] = [];
	/** The list of tracks from the input file that have been discarded, alongside the discard reason. */
	readonly discardedTracks: {
		/** The track that was discarded. */
		track: InputTrack;
		/** The reason for discarding the track. */
		reason:
			| 'discarded_by_user'
			| 'max_track_count_reached'
			| 'max_track_count_of_type_reached'
			| 'unknown_source_codec'
			| 'undecodable_source_codec'
			| 'no_encodable_target_codec';
	}[] = [];

	/** Initializes a new conversion process without starting the conversion. */
	static async init(options: ConversionOptions) {
		const conversion = new Conversion(options);
		await conversion._init();

		return conversion;
	}

	private constructor(options: ConversionOptions) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (!(options.input instanceof Input)) {
			throw new TypeError('options.input must be an Input.');
		}
		if (!(options.output instanceof Output)) {
			throw new TypeError('options.output must be an Output.');
		}
		if (options.output._tracks.length > 0 || options.output.state !== 'pending') {
			throw new TypeError('options.output must be fresh: no tracks added and not started.');
		}
		if (options.video !== undefined && (!options.video || typeof options.video !== 'object')) {
			throw new TypeError('options.video, when provided, must be an object.');
		}
		if (options.video?.discard !== undefined && typeof options.video.discard !== 'boolean') {
			throw new TypeError('options.video.discard, when provided, must be a boolean.');
		}
		if (options.video?.forceTranscode !== undefined && typeof options.video.forceTranscode !== 'boolean') {
			throw new TypeError('options.video.forceTranscode, when provided, must be a boolean.');
		}
		if (options.video?.codec !== undefined && !VIDEO_CODECS.includes(options.video.codec)) {
			throw new TypeError(
				`options.video.codec, when provided, must be one of: ${VIDEO_CODECS.join(', ')}.`,
			);
		}
		if (
			options.video?.bitrate !== undefined
			&& !(options.video.bitrate instanceof Quality)
			&& (!Number.isInteger(options.video.bitrate) || options.video.bitrate <= 0)
		) {
			throw new TypeError('options.video.bitrate, when provided, must be a positive integer or a quality.');
		}
		if (
			options.video?.width !== undefined
			&& (!Number.isInteger(options.video.width) || options.video.width <= 0)
		) {
			throw new TypeError('options.video.width, when provided, must be a positive integer.');
		}
		if (
			options.video?.height !== undefined
			&& (!Number.isInteger(options.video.height) || options.video.height <= 0)
		) {
			throw new TypeError('options.video.height, when provided, must be a positive integer.');
		}
		if (options.video?.fit !== undefined && !['fill', 'contain', 'cover'].includes(options.video.fit)) {
			throw new TypeError('options.video.fit, when provided, must be one of "fill", "contain", or "cover".');
		}
		if (
			options.video?.width !== undefined
			&& options.video.height !== undefined
			&& options.video.fit === undefined
		) {
			throw new TypeError(
				'When both options.video.width and options.video.height are provided, options.video.fit must also be'
				+ ' provided.',
			);
		}
		if (options.video?.rotate !== undefined && ![0, 90, 180, 270].includes(options.video.rotate)) {
			throw new TypeError('options.video.rotate, when provided, must be 0, 90, 180 or 270.');
		}
		if (
			options.video?.frameRate !== undefined
			&& (!Number.isFinite(options.video.frameRate) || options.video.frameRate <= 0)
		) {
			throw new TypeError('options.video.frameRate, when provided, must be a finite positive number.');
		}
		if (options.audio !== undefined && (!options.audio || typeof options.audio !== 'object')) {
			throw new TypeError('options.audio, when provided, must be an object.');
		}
		if (options.audio?.discard !== undefined && typeof options.audio.discard !== 'boolean') {
			throw new TypeError('options.audio.discard, when provided, must be a boolean.');
		}
		if (options.audio?.forceTranscode !== undefined && typeof options.audio.forceTranscode !== 'boolean') {
			throw new TypeError('options.audio.forceTranscode, when provided, must be a boolean.');
		}
		if (options.audio?.codec !== undefined && !AUDIO_CODECS.includes(options.audio.codec)) {
			throw new TypeError(
				`options.audio.codec, when provided, must be one of: ${AUDIO_CODECS.join(', ')}.`,
			);
		}
		if (
			options.audio?.bitrate !== undefined
			&& !(options.audio.bitrate instanceof Quality)
			&& (!Number.isInteger(options.audio.bitrate) || options.audio.bitrate <= 0)
		) {
			throw new TypeError('options.audio.bitrate, when provided, must be a positive integer or a quality.');
		}
		if (
			options.audio?.numberOfChannels !== undefined
			&& (!Number.isInteger(options.audio.numberOfChannels) || options.audio.numberOfChannels <= 0)
		) {
			throw new TypeError('options.audio.numberOfChannels, when provided, must be a positive integer.');
		}
		if (
			options.audio?.sampleRate !== undefined
			&& (!Number.isInteger(options.audio.sampleRate) || options.audio.sampleRate <= 0)
		) {
			throw new TypeError('options.audio.sampleRate, when provided, must be a positive integer.');
		}
		if (options.trim !== undefined && (!options.trim || typeof options.trim !== 'object')) {
			throw new TypeError('options.trim, when provided, must be an object.');
		}
		if (options.trim?.start !== undefined && (!Number.isFinite(options.trim.start) || options.trim.start < 0)) {
			throw new TypeError('options.trim.start, when provided, must be a non-negative number.');
		}
		if (options.trim?.end !== undefined && (!Number.isFinite(options.trim.end) || options.trim.end < 0)) {
			throw new TypeError('options.trim.end, when provided, must be a non-negative number.');
		}
		if (
			options.trim?.start !== undefined
			&& options.trim.end !== undefined
			&& options.trim.start >= options.trim.end) {
			throw new TypeError('options.trim.start must be less than options.trim.end.');
		}
		if (options.tracks !== undefined && (!options.tracks || typeof options.tracks !== 'object')) {
			throw new TypeError('options.tracks, when provided, must be an object.');
		}
		if (
			options.tracks?.indices !== undefined
			&& (!Array.isArray(options.tracks.indices)
				|| !options.tracks.indices.every(i => Number.isInteger(i) && i >= 0))
		) {
			throw new TypeError('options.tracks.indices, when provided, must be an array of non-negative integers.');
		}
		if (options.tracks?.audioOnly !== undefined && typeof options.tracks.audioOnly !== 'boolean') {
			throw new TypeError('options.tracks.audioOnly, when provided, must be a boolean.');
		}

		this._options = options;
		this.input = options.input;
		this.output = options.output;

		this._startTimestamp = options.trim?.start ?? 0;
		this._endTimestamp = options.trim?.end ?? Infinity;

		const { promise: started, resolve: start } = promiseWithResolvers();
		this._started = started;
		this._start = start;
	}

	/** @internal */
	async _init() {
		let inputTracks = await this.input.getTracks();
		const outputTrackCounts = this.output.format.getSupportedTrackCounts();

		// Filter tracks based on options
		if (this._options.tracks) {
			// First filter by track type if audioOnly is specified
			if (this._options.tracks.audioOnly) {
				inputTracks = inputTracks.filter(track => track.type === 'audio');
			}
			// Then filter by indices - indices now apply to the filtered list
			if (this._options.tracks.indices !== undefined) {
				inputTracks = inputTracks.filter((_, index) =>
					this._options.tracks!.indices!.includes(index),
				);
			}
		}

		for (const track of inputTracks) {
			if (track.isVideoTrack() && this._options.video?.discard) {
				this.discardedTracks.push({
					track,
					reason: 'discarded_by_user',
				});
				continue;
			}

			if (track.isAudioTrack() && this._options.audio?.discard) {
				this.discardedTracks.push({
					track,
					reason: 'discarded_by_user',
				});
				continue;
			}

			if (this._totalTrackCount === outputTrackCounts.total.max) {
				this.discardedTracks.push({
					track,
					reason: 'max_track_count_reached',
				});
				continue;
			}

			if (this._addedCounts[track.type] === outputTrackCounts[track.type].max) {
				this.discardedTracks.push({
					track,
					reason: 'max_track_count_of_type_reached',
				});
				continue;
			}

			if (track.isVideoTrack()) {
				await this._processVideoTrack(track);
			} else if (track.isAudioTrack()) {
				await this._processAudioTrack(track);
			}
		}

		const unintentionallyDiscardedTracks = this.discardedTracks.filter(x => x.reason !== 'discarded_by_user');
		if (unintentionallyDiscardedTracks.length > 0) {
			// Let's give the user a notice/warning about discarded tracks so they aren't confused
			console.warn('Some tracks had to be discarded from the conversion:', unintentionallyDiscardedTracks);
		}
	}

	/** Executes the conversion process. Resolves once conversion is complete. */
	async execute() {
		if (this._executed) {
			throw new Error('Conversion cannot be executed twice.');
		}

		this._executed = true;

		if (this.onProgress) {
			this._computeProgress = true;
			this._totalDuration = Math.min(
				await this.input.computeDuration() - this._startTimestamp,
				this._endTimestamp - this._startTimestamp,
			);
			this.onProgress?.(0);
		}

		await this.output.start();
		this._start();

		try {
			await Promise.all(this._trackPromises);
		} catch (error) {
			if (!this._canceled) {
				// Make sure to cancel to stop other encoding processes and clean up resources
				await this.cancel();
			}

			throw error;
		}

		if (this._canceled) {
			await new Promise(() => {}); // Never resolve
		}

		await this.output.finalize();

		if (this._computeProgress) {
			this.onProgress?.(1);
		}
	}

	/** Cancels the conversion process. Does nothing if the conversion is already complete. */
	async cancel() {
		if (this.output.state === 'finalizing' || this.output.state === 'finalized') {
			return;
		}

		if (this._canceled) {
			console.warn('Conversion already canceled.');
			return;
		}

		this._canceled = true;
		await this.output.cancel();
	}

	/** @internal */
	async _processVideoTrack(track: InputVideoTrack) {
		const sourceCodec = track.codec;
		if (!sourceCodec) {
			this.discardedTracks.push({
				track,
				reason: 'unknown_source_codec',
			});
			return;
		}

		let videoSource: VideoSource;

		const totalRotation = normalizeRotation(track.rotation + (this._options.video?.rotate ?? 0));
		const outputSupportsRotation = this.output.format.supportsVideoRotationMetadata;

		const [originalWidth, originalHeight] = totalRotation % 180 === 0
			? [track.codedWidth, track.codedHeight]
			: [track.codedHeight, track.codedWidth];

		let width = originalWidth;
		let height = originalHeight;
		const aspectRatio = width / height;

		// A lot of video encoders require that the dimensions be multiples of 2
		const ceilToMultipleOfTwo = (value: number) => Math.ceil(value / 2) * 2;

		if (this._options.video?.width !== undefined && this._options.video.height === undefined) {
			width = ceilToMultipleOfTwo(this._options.video.width);
			height = ceilToMultipleOfTwo(Math.round(width / aspectRatio));
		} else if (this._options.video?.width === undefined && this._options.video?.height !== undefined) {
			height = ceilToMultipleOfTwo(this._options.video.height);
			width = ceilToMultipleOfTwo(Math.round(height * aspectRatio));
		} else if (this._options.video?.width !== undefined && this._options.video.height !== undefined) {
			width = ceilToMultipleOfTwo(this._options.video.width);
			height = ceilToMultipleOfTwo(this._options.video.height);
		}

		const firstTimestamp = await track.getFirstTimestamp();
		const needsTranscode = !!this._options.video?.forceTranscode
			|| this._startTimestamp > 0
			|| firstTimestamp < 0
			|| !!this._options.video?.frameRate;
		const needsRerender = width !== originalWidth
			|| height !== originalHeight
			|| (totalRotation !== 0 && !outputSupportsRotation);

		let videoCodecs = this.output.format.getSupportedVideoCodecs();
		if (
			!needsTranscode
			&& !this._options.video?.bitrate
			&& !needsRerender
			&& videoCodecs.includes(sourceCodec)
			&& (!this._options.video?.codec || this._options.video?.codec === sourceCodec)
		) {
			// Fast path, we can simply copy over the encoded packets

			const source = new EncodedVideoPacketSource(sourceCodec);
			videoSource = source;

			this._trackPromises.push((async () => {
				await this._started;

				const sink = new EncodedPacketSink(track);
				const decoderConfig = await track.getDecoderConfig();
				const meta: EncodedVideoChunkMetadata = { decoderConfig: decoderConfig ?? undefined };
				const endPacket = Number.isFinite(this._endTimestamp)
					? await sink.getPacket(this._endTimestamp, { metadataOnly: true }) ?? undefined
					: undefined;

				for await (const packet of sink.packets(undefined, endPacket, { verifyKeyPackets: true })) {
					if (this._synchronizer.shouldWait(track.id, packet.timestamp)) {
						await this._synchronizer.wait(packet.timestamp);
					}

					if (this._canceled) {
						return;
					}

					await source.add(packet, meta);
					this._reportProgress(track.id, packet.timestamp + packet.duration);
				}

				source.close();
				this._synchronizer.closeTrack(track.id);
			})());
		} else {
			// We need to decode & reencode the video

			const canDecode = await track.canDecode();
			if (!canDecode) {
				this.discardedTracks.push({
					track,
					reason: 'undecodable_source_codec',
				});
				return;
			}

			if (this._options.video?.codec) {
				videoCodecs = videoCodecs.filter(codec => codec === this._options.video?.codec);
			}

			const bitrate = this._options.video?.bitrate ?? QUALITY_HIGH;

			const encodableCodec = await getFirstEncodableVideoCodec(videoCodecs, { width, height, bitrate });
			if (!encodableCodec) {
				this.discardedTracks.push({
					track,
					reason: 'no_encodable_target_codec',
				});
				return;
			}

			const encodingConfig: VideoEncodingConfig = {
				codec: encodableCodec,
				bitrate,
				onEncodedPacket: sample => this._reportProgress(track.id, sample.timestamp + sample.duration),
			};

			const source = new VideoSampleSource(encodingConfig);
			videoSource = source;

			if (needsRerender) {
				this._trackPromises.push((async () => {
					await this._started;

					const sink = new CanvasSink(track, {
						width,
						height,
						fit: this._options.video?.fit ?? 'fill',
						rotation: totalRotation, // Bake the rotation into the output
						poolSize: 1,
					});
					const iterator = sink.canvases(this._startTimestamp, this._endTimestamp);
					const frameRate = this._options.video?.frameRate;

					let lastCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
					let lastCanvasTimestamp: number | null = null;
					let lastCanvasEndTimestamp: number | null = null;

					/** Repeats the last sample to pad out the time until the specified timestamp. */
					const padFrames = async (until: number) => {
						assert(lastCanvas);
						assert(frameRate !== undefined);

						const frameDifference = Math.round((until - lastCanvasTimestamp!) * frameRate);

						for (let i = 1; i < frameDifference; i++) {
							const sample = new VideoSample(lastCanvas, {
								timestamp: lastCanvasTimestamp! + i / frameRate,
								duration: 1 / frameRate,
							});
							await source.add(sample);
						}
					};

					for await (const { canvas, timestamp, duration } of iterator) {
						if (this._synchronizer.shouldWait(track.id, timestamp)) {
							await this._synchronizer.wait(timestamp);
						}

						if (this._canceled) {
							return;
						}

						let adjustedSampleTimestamp = Math.max(timestamp - this._startTimestamp, 0);
						lastCanvasEndTimestamp = timestamp + duration;

						if (frameRate !== undefined) {
							// Logic for skipping/repeating frames when a frame rate is set
							const alignedTimestamp = Math.floor(adjustedSampleTimestamp * frameRate) / frameRate;

							if (lastCanvas !== null) {
								if (alignedTimestamp <= lastCanvasTimestamp!) {
									lastCanvas = canvas;
									lastCanvasTimestamp = alignedTimestamp;

									// Skip this sample, since we already added one for this frame
									continue;
								} else {
									// Check if we may need to repeat the previous frame
									await padFrames(alignedTimestamp);
								}
							}

							adjustedSampleTimestamp = alignedTimestamp;
						}

						const sample = new VideoSample(canvas, {
							timestamp: adjustedSampleTimestamp,
							duration: frameRate !== undefined ? 1 / frameRate : duration,
						});

						await source.add(sample);

						if (frameRate !== undefined) {
							lastCanvas = canvas;
							lastCanvasTimestamp = adjustedSampleTimestamp;
						} else {
							sample.close();
						}
					}

					if (lastCanvas) {
						assert(lastCanvasEndTimestamp !== null);
						assert(frameRate !== undefined);

						// If necessary, pad until the end timestamp of the last sample
						await padFrames(Math.floor(lastCanvasEndTimestamp * frameRate) / frameRate);
					}

					source.close();
					this._synchronizer.closeTrack(track.id);
				})());
			} else {
				this._trackPromises.push((async () => {
					await this._started;

					const sink = new VideoSampleSink(track);
					const frameRate = this._options.video?.frameRate;

					let lastSample: VideoSample | null = null;
					let lastSampleTimestamp: number | null = null;
					let lastSampleEndTimestamp: number | null = null;

					/** Repeats the last sample to pad out the time until the specified timestamp. */
					const padFrames = async (until: number) => {
						assert(lastSample);
						assert(frameRate !== undefined);

						const frameDifference = Math.round((until - lastSampleTimestamp!) * frameRate);

						for (let i = 1; i < frameDifference; i++) {
							lastSample.setTimestamp(lastSampleTimestamp! + i / frameRate);
							lastSample.setDuration(1 / frameRate);
							await source.add(lastSample);
						}

						lastSample.close();
					};

					for await (const sample of sink.samples(this._startTimestamp, this._endTimestamp)) {
						if (this._synchronizer.shouldWait(track.id, sample.timestamp)) {
							await this._synchronizer.wait(sample.timestamp);
						}

						if (this._canceled) {
							lastSample?.close();
							return;
						}

						let adjustedSampleTimestamp = Math.max(sample.timestamp - this._startTimestamp, 0);
						lastSampleEndTimestamp = sample.timestamp + sample.duration;

						if (frameRate !== undefined) {
							// Logic for skipping/repeating frames when a frame rate is set
							const alignedTimestamp = Math.floor(adjustedSampleTimestamp * frameRate) / frameRate;

							if (lastSample !== null) {
								if (alignedTimestamp <= lastSampleTimestamp!) {
									lastSample.close();
									lastSample = sample;
									lastSampleTimestamp = alignedTimestamp;

									// Skip this sample, since we already added one for this frame
									continue;
								} else {
									// Check if we may need to repeat the previous frame
									await padFrames(alignedTimestamp);
								}
							}

							adjustedSampleTimestamp = alignedTimestamp;
							sample.setDuration(1 / frameRate);
						}

						sample.setTimestamp(adjustedSampleTimestamp);
						await source.add(sample);

						if (frameRate !== undefined) {
							lastSample = sample;
							lastSampleTimestamp = adjustedSampleTimestamp;
						} else {
							sample.close();
						}
					}

					if (lastSample) {
						assert(lastSampleEndTimestamp !== null);
						assert(frameRate !== undefined);

						// If necessary, pad until the end timestamp of the last sample
						await padFrames(Math.floor(lastSampleEndTimestamp * frameRate) / frameRate);
					}

					source.close();
					this._synchronizer.closeTrack(track.id);
				})());
			}
		}

		this.output.addVideoTrack(videoSource, {
			frameRate: this._options.video?.frameRate,
			languageCode: track.languageCode,
			rotation: needsRerender ? 0 : totalRotation, // Rerendering will bake the rotation into the output
		});
		this._addedCounts.video++;
		this._totalTrackCount++;

		this.utilizedTracks.push(track);
	}

	/** @internal */
	async _processAudioTrack(track: InputAudioTrack) {
		const sourceCodec = track.codec;
		if (!sourceCodec) {
			this.discardedTracks.push({
				track,
				reason: 'unknown_source_codec',
			});
			return;
		}

		let audioSource: AudioSource;

		const originalNumberOfChannels = track.numberOfChannels;
		const originalSampleRate = track.sampleRate;

		const firstTimestamp = await track.getFirstTimestamp();

		let numberOfChannels = this._options.audio?.numberOfChannels ?? originalNumberOfChannels;
		let sampleRate = this._options.audio?.sampleRate ?? originalSampleRate;
		let needsResample = numberOfChannels !== originalNumberOfChannels
			|| sampleRate !== originalSampleRate
			|| this._startTimestamp > 0;
			// Removed: || firstTimestamp < 0 - negative timestamps don't require resampling

		let audioCodecs = this.output.format.getSupportedAudioCodecs();
		if (
			!this._options.audio?.forceTranscode
			&& !this._options.audio?.bitrate
			&& !needsResample
			&& audioCodecs.includes(sourceCodec)
			&& (!this._options.audio?.codec || this._options.audio.codec === sourceCodec)
		) {
			// Fast path, we can simply copy over the encoded packets

			const source = new EncodedAudioPacketSource(sourceCodec);
			audioSource = source;

			this._trackPromises.push((async () => {
				await this._started;

				const sink = new EncodedPacketSink(track);
				const decoderConfig = await track.getDecoderConfig();
				const meta: EncodedAudioChunkMetadata = { decoderConfig: decoderConfig ?? undefined };
				const endPacket = Number.isFinite(this._endTimestamp)
					? await sink.getPacket(this._endTimestamp, { metadataOnly: true }) ?? undefined
					: undefined;

				// Add timestamp offset handling for negative timestamps
				const timestampOffset = firstTimestamp < 0 ? -firstTimestamp : 0;

				for await (const packet of sink.packets(undefined, endPacket)) {
					// Offset negative timestamps to make them non-negative
					const adjustedPacket = timestampOffset > 0
						? new EncodedPacket(
							packet.data,
							packet.type,
							packet.timestamp + timestampOffset,
							packet.duration,
							packet.sequenceNumber,
							packet.byteLength,
						)
						: packet;

					if (this._synchronizer.shouldWait(track.id, adjustedPacket.timestamp)) {
						await this._synchronizer.wait(adjustedPacket.timestamp);
					}

					if (this._canceled) {
						return;
					}

					await source.add(adjustedPacket, meta);
					this._reportProgress(track.id, adjustedPacket.timestamp + adjustedPacket.duration);
				}

				source.close();
				this._synchronizer.closeTrack(track.id);
			})());
		} else {
			// We need to decode & reencode the audio

			const canDecode = await track.canDecode();
			if (!canDecode) {
				this.discardedTracks.push({
					track,
					reason: 'undecodable_source_codec',
				});
				return;
			}

			let codecOfChoice: AudioCodec | null = null;

			if (this._options.audio?.codec) {
				audioCodecs = audioCodecs.filter(codec => codec === this._options.audio!.codec);
			}

			const bitrate = this._options.audio?.bitrate ?? QUALITY_HIGH;

			const encodableCodecs = await getEncodableAudioCodecs(audioCodecs, {
				numberOfChannels,
				sampleRate,
				bitrate,
			});

			if (
				!encodableCodecs.some(codec => (NON_PCM_AUDIO_CODECS as readonly string[]).includes(codec))
				&& audioCodecs.some(codec => (NON_PCM_AUDIO_CODECS as readonly string[]).includes(codec))
				&& (numberOfChannels !== FALLBACK_NUMBER_OF_CHANNELS || sampleRate !== FALLBACK_SAMPLE_RATE)
			) {
				// We could not find a compatible non-PCM codec despite the container supporting them. This can be
				// caused by strange channel count or sample rate configurations. Therefore, let's try again but with
				// fallback parameters.

				const encodableCodecsWithDefaultParams = await getEncodableAudioCodecs(audioCodecs, {
					numberOfChannels: FALLBACK_NUMBER_OF_CHANNELS,
					sampleRate: FALLBACK_SAMPLE_RATE,
					bitrate,
				});

				const nonPcmCodec = encodableCodecsWithDefaultParams
					.find(codec => (NON_PCM_AUDIO_CODECS as readonly string[]).includes(codec));
				if (nonPcmCodec) {
					// We are able to encode using a non-PCM codec, but it'll require resampling
					needsResample = true;
					codecOfChoice = nonPcmCodec;
					numberOfChannels = FALLBACK_NUMBER_OF_CHANNELS;
					sampleRate = FALLBACK_SAMPLE_RATE;
				}
			} else {
				codecOfChoice = encodableCodecs[0] ?? null;
			}

			if (codecOfChoice === null) {
				this.discardedTracks.push({
					track,
					reason: 'no_encodable_target_codec',
				});
				return;
			}

			if (needsResample) {
				audioSource = this._resampleAudio(track, codecOfChoice, numberOfChannels, sampleRate, bitrate);
			} else {
				const source = new AudioSampleSource({
					codec: codecOfChoice,
					bitrate,
					onEncodedPacket: packet => this._reportProgress(track.id, packet.timestamp + packet.duration),
				});
				audioSource = source;

				this._trackPromises.push((async () => {
					await this._started;

					const sink = new AudioSampleSink(track);
					for await (const sample of sink.samples(undefined, this._endTimestamp)) {
						if (this._synchronizer.shouldWait(track.id, sample.timestamp)) {
							await this._synchronizer.wait(sample.timestamp);
						}

						if (this._canceled) {
							return;
						}

						await source.add(sample);
						sample.close();
					}

					source.close();
					this._synchronizer.closeTrack(track.id);
				})());
			}
		}

		this.output.addAudioTrack(audioSource, {
			languageCode: track.languageCode,
		});
		this._addedCounts.audio++;
		this._totalTrackCount++;

		this.utilizedTracks.push(track);
	}

	/** @internal */
	_resampleAudio(
		track: InputAudioTrack,
		codec: AudioCodec,
		targetNumberOfChannels: number,
		targetSampleRate: number,
		bitrate: number | Quality,
	) {
		const source = new AudioSampleSource({
			codec,
			bitrate,
			onEncodedPacket: packet => this._reportProgress(track.id, packet.timestamp + packet.duration),
		});

		this._trackPromises.push((async () => {
			await this._started;

			const resampler = new AudioResampler({
				sourceNumberOfChannels: track.numberOfChannels,
				sourceSampleRate: track.sampleRate,
				targetNumberOfChannels,
				targetSampleRate,
				startTime: this._startTimestamp,
				endTime: this._endTimestamp,
				onSample: sample => source.add(sample),
			});

			const sink = new AudioSampleSink(track);
			const iterator = sink.samples(this._startTimestamp, this._endTimestamp);

			for await (const sample of iterator) {
				if (this._synchronizer.shouldWait(track.id, sample.timestamp)) {
					await this._synchronizer.wait(sample.timestamp);
				}

				if (this._canceled) {
					return;
				}

				await resampler.add(sample);
			}

			await resampler.finalize();

			source.close();
			this._synchronizer.closeTrack(track.id);
		})());

		return source;
	}

	/** @internal */
	_reportProgress(trackId: number, endTimestamp: number) {
		if (!this._computeProgress) {
			return;
		}
		assert(this._totalDuration !== null);

		this._maxTimestamps.set(trackId, Math.max(endTimestamp, this._maxTimestamps.get(trackId) ?? -Infinity));

		let totalTimestamps = 0;
		for (const [, timestamp] of this._maxTimestamps) {
			totalTimestamps += timestamp;
		}

		const averageTimestamp = totalTimestamps / this._totalTrackCount;
		const newProgress = clamp(averageTimestamp / this._totalDuration, 0, 1);

		if (newProgress !== this._lastProgress) {
			this._lastProgress = newProgress;
			this.onProgress?.(newProgress);
		}
	}
}

const MAX_TIMESTAMP_GAP = 5;

/**
 * Utility class for synchronizing multiple track packet consumers with one another. We don't want one consumer to get
 * too out-of-sync with the others, as that may lead to a large number of packets that need to be internally buffered
 * before they can be written. Therefore, we use this class to slow down a consumer if it is too far ahead of the
 * slowest consumer.
 */
class TrackSynchronizer {
	maxTimestamps = new Map<number, number>(); // Track ID -> timestamp
	resolvers: {
		timestamp: number;
		resolve: () => void;
	}[] = [];

	computeMinAndMaybeResolve() {
		let newMin = Infinity;
		for (const [, timestamp] of this.maxTimestamps) {
			newMin = Math.min(newMin, timestamp);
		}

		for (let i = 0; i < this.resolvers.length; i++) {
			const entry = this.resolvers[i]!;

			if (entry.timestamp - newMin < MAX_TIMESTAMP_GAP) {
				// The gap has gotten small enough again, the consumer can continue again
				entry.resolve();
				this.resolvers.splice(i, 1);
				i--;
			}
		}

		return newMin;
	}

	shouldWait(trackId: number, timestamp: number) {
		this.maxTimestamps.set(trackId, Math.max(timestamp, this.maxTimestamps.get(trackId) ?? -Infinity));

		const newMin = this.computeMinAndMaybeResolve();
		return timestamp - newMin >= MAX_TIMESTAMP_GAP; // Should wait if it is too far ahead of the slowest consumer
	}

	wait(timestamp: number) {
		const { promise, resolve } = promiseWithResolvers();

		this.resolvers.push({
			timestamp,
			resolve,
		});

		return promise;
	}

	closeTrack(trackId: number) {
		this.maxTimestamps.delete(trackId);
		this.computeMinAndMaybeResolve();
	}
}

/**
 * Utility class to handle audio resampling, handling both sample rate resampling as well as channel up/downmixing.
 * The advantage over doing this manually rather than using OfflineAudioContext to do it for us is the artifact-free
 * handling of putting multiple resampled audio samples back to back, which produces flaky results using
 * OfflineAudioContext.
 */
export class AudioResampler {
	sourceSampleRate: number;
	targetSampleRate: number;
	sourceNumberOfChannels: number;
	targetNumberOfChannels: number;
	startTime: number;
	endTime: number;
	onSample: (sample: AudioSample) => Promise<void>;

	bufferSizeInFrames: number;
	bufferSizeInSamples: number;
	outputBuffer: Float32Array;
	/** Start frame of current buffer */
	bufferStartFrame: number;
	/** The highest index written to in the current buffer */
	maxWrittenFrame: number;
	channelMixer!: (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => number;
	tempSourceBuffer: Float32Array;

	constructor(options: {
		sourceSampleRate: number;
		targetSampleRate: number;
		sourceNumberOfChannels: number;
		targetNumberOfChannels: number;
		startTime: number;
		endTime: number;
		onSample: (sample: AudioSample) => Promise<void>;
	}) {
		this.sourceSampleRate = options.sourceSampleRate;
		this.targetSampleRate = options.targetSampleRate;
		this.sourceNumberOfChannels = options.sourceNumberOfChannels;
		this.targetNumberOfChannels = options.targetNumberOfChannels;
		this.startTime = options.startTime;
		this.endTime = options.endTime;
		this.onSample = options.onSample;

		this.bufferSizeInFrames = Math.floor(this.targetSampleRate * 5.0); // 5 seconds
		this.bufferSizeInSamples = this.bufferSizeInFrames * this.targetNumberOfChannels;

		this.outputBuffer = new Float32Array(this.bufferSizeInSamples);
		this.bufferStartFrame = 0;
		this.maxWrittenFrame = -1;

		this.setupChannelMixer();

		// Pre-allocate temporary buffer for source data
		this.tempSourceBuffer = new Float32Array(this.sourceSampleRate * this.sourceNumberOfChannels);
	}

	/**
	 * Sets up the channel mixer to handle up/downmixing in the case where input and output channel counts don't match.
	 */
	setupChannelMixer(): void {
		const sourceNum = this.sourceNumberOfChannels;
		const targetNum = this.targetNumberOfChannels;

		// Logic taken from
		// https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Basic_concepts_behind_Web_Audio_API
		// Most of the mapping functions are branchless.

		if (sourceNum === 1 && targetNum === 2) {
			// Mono to Stereo: M -> L, M -> R
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]!;
			};
		} else if (sourceNum === 1 && targetNum === 4) {
			// Mono to Quad: M -> L, M -> R, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]! * +(targetChannelIndex < 2);
			};
		} else if (sourceNum === 1 && targetNum === 6) {
			// Mono to 5.1: 0 -> L, 0 -> R, M -> C, 0 -> LFE, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum]! * +(targetChannelIndex === 2);
			};
		} else if (sourceNum === 2 && targetNum === 1) {
			// Stereo to Mono: 0.5 * (L + R)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.5 * (sourceData[baseIdx]! + sourceData[baseIdx + 1]!);
			};
		} else if (sourceNum === 2 && targetNum === 4) {
			// Stereo to Quad: L -> L, R -> R, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]! * +(targetChannelIndex < 2);
			};
		} else if (sourceNum === 2 && targetNum === 6) {
			// Stereo to 5.1: L -> L, R -> R, 0 -> C, 0 -> LFE, 0 -> SL, 0 -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]! * +(targetChannelIndex < 2);
			};
		} else if (sourceNum === 4 && targetNum === 1) {
			// Quad to Mono: 0.25 * (L + R + SL + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.25 * (
					sourceData[baseIdx]! + sourceData[baseIdx + 1]!
					+ sourceData[baseIdx + 2]! + sourceData[baseIdx + 3]!
				);
			};
		} else if (sourceNum === 4 && targetNum === 2) {
			// Quad to Stereo: 0.5 * (L + SL), 0.5 * (R + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return 0.5 * (
					sourceData[baseIdx + targetChannelIndex]!
					+ sourceData[baseIdx + targetChannelIndex + 2]!
				);
			};
		} else if (sourceNum === 4 && targetNum === 6) {
			// Quad to 5.1: L -> L, R -> R, 0 -> C, 0 -> LFE, SL -> SL, SR -> SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;

				// It's a bit harder to do this one branchlessly
				if (targetChannelIndex < 2) return sourceData[baseIdx + targetChannelIndex]!; // L, R
				if (targetChannelIndex === 2 || targetChannelIndex === 3) return 0; // C, LFE
				return sourceData[baseIdx + targetChannelIndex - 2]!; // SL, SR
			};
		} else if (sourceNum === 6 && targetNum === 1) {
			// 5.1 to Mono: sqrt(1/2) * (L + R) + C + 0.5 * (SL + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return Math.SQRT1_2 * (sourceData[baseIdx]! + sourceData[baseIdx + 1]!)
					+ sourceData[baseIdx + 2]!
					+ 0.5 * (sourceData[baseIdx + 4]! + sourceData[baseIdx + 5]!);
			};
		} else if (sourceNum === 6 && targetNum === 2) {
			// 5.1 to Stereo: L + sqrt(1/2) * (C + SL), R + sqrt(1/2) * (C + SR)
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;
				return sourceData[baseIdx + targetChannelIndex]!
					+ Math.SQRT1_2 * (sourceData[baseIdx + 2]! + sourceData[baseIdx + targetChannelIndex + 4]!);
			};
		} else if (sourceNum === 6 && targetNum === 4) {
			// 5.1 to Quad: L + sqrt(1/2) * C, R + sqrt(1/2) * C, SL, SR
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				const baseIdx = sourceFrameIndex * sourceNum;

				// It's a bit harder to do this one branchlessly
				if (targetChannelIndex < 2) {
					return sourceData[baseIdx + targetChannelIndex]! + Math.SQRT1_2 * sourceData[baseIdx + 2]!;
				}
				return sourceData[baseIdx + targetChannelIndex + 2]!; // SL, SR
			};
		} else {
			// Discrete fallback: direct mapping with zero-fill or drop
			this.channelMixer = (sourceData: Float32Array, sourceFrameIndex: number, targetChannelIndex: number) => {
				return targetChannelIndex < sourceNum
					? sourceData[sourceFrameIndex * sourceNum + targetChannelIndex]!
					: 0;
			};
		}
	}

	ensureTempBufferSize(requiredSamples: number): void {
		let length = this.tempSourceBuffer.length;

		while (length < requiredSamples) {
			length *= 2;
		}

		if (length !== this.tempSourceBuffer.length) {
			const newBuffer = new Float32Array(length);
			newBuffer.set(this.tempSourceBuffer);
			this.tempSourceBuffer = newBuffer;
		}
	}

	async add(audioSample: AudioSample) {
		if (!audioSample || audioSample._closed) {
			return;
		}

		const requiredSamples = audioSample.numberOfFrames * audioSample.numberOfChannels;
		this.ensureTempBufferSize(requiredSamples);

		// Copy the audio data to the temp buffer
		const sourceDataSize = audioSample.allocationSize({ planeIndex: 0, format: 'f32' });
		const sourceView = new Float32Array(this.tempSourceBuffer.buffer, 0, sourceDataSize / 4);
		audioSample.copyTo(sourceView, { planeIndex: 0, format: 'f32' });

		const inputStartTime = audioSample.timestamp - this.startTime;
		const inputDuration = audioSample.numberOfFrames / this.sourceSampleRate;
		const inputEndTime = Math.min(inputStartTime + inputDuration, this.endTime - this.startTime);

		// Compute which output frames are affected by this sample
		const outputStartFrame = Math.floor(inputStartTime * this.targetSampleRate);
		const outputEndFrame = Math.ceil(inputEndTime * this.targetSampleRate);

		for (let outputFrame = outputStartFrame; outputFrame < outputEndFrame; outputFrame++) {
			if (outputFrame < this.bufferStartFrame) {
				continue; // Skip writes to the past
			}

			while (outputFrame >= this.bufferStartFrame + this.bufferSizeInFrames) {
				// The write is after the current buffer, so finalize it
				await this.finalizeCurrentBuffer();
				this.bufferStartFrame += this.bufferSizeInFrames;
			}

			const bufferFrameIndex = outputFrame - this.bufferStartFrame;
			assert(bufferFrameIndex < this.bufferSizeInFrames);

			const outputTime = outputFrame / this.targetSampleRate;
			const inputTime = outputTime - inputStartTime;
			const sourcePosition = inputTime * this.sourceSampleRate;

			const sourceLowerFrame = Math.floor(sourcePosition);
			const sourceUpperFrame = Math.ceil(sourcePosition);
			const fraction = sourcePosition - sourceLowerFrame;

			// Process each output channel
			for (let targetChannel = 0; targetChannel < this.targetNumberOfChannels; targetChannel++) {
				let lowerSample = 0;
				let upperSample = 0;

				if (sourceLowerFrame >= 0 && sourceLowerFrame < audioSample.numberOfFrames) {
					lowerSample = this.channelMixer(sourceView, sourceLowerFrame, targetChannel);
				}

				if (sourceUpperFrame >= 0 && sourceUpperFrame < audioSample.numberOfFrames) {
					upperSample = this.channelMixer(sourceView, sourceUpperFrame, targetChannel);
				}

				// For resampling, we do naive linear interpolation to find the in-between sample. This produces
				// suboptimal results especially for downsampling (for which a low-pass filter would first need to be
				// applied), but AudioContext doesn't do this either, so, whatever, for now.
				const outputSample = lowerSample + fraction * (upperSample - lowerSample);

				// Write to output buffer (interleaved)
				const outputIndex = bufferFrameIndex * this.targetNumberOfChannels + targetChannel;
				this.outputBuffer[outputIndex]! += outputSample; // Add in case of overlapping samples
			}

			this.maxWrittenFrame = Math.max(this.maxWrittenFrame, bufferFrameIndex);
		}
	}

	async finalizeCurrentBuffer() {
		if (this.maxWrittenFrame < 0) {
			return; // Nothing to finalize
		}

		const samplesWritten = (this.maxWrittenFrame + 1) * this.targetNumberOfChannels;

		const outputData = new Float32Array(samplesWritten);
		outputData.set(this.outputBuffer.subarray(0, samplesWritten));

		const timestampSeconds = this.bufferStartFrame / this.targetSampleRate;
		const audioSample = new AudioSample({
			format: 'f32',
			sampleRate: this.targetSampleRate,
			numberOfChannels: this.targetNumberOfChannels,
			timestamp: timestampSeconds,
			data: outputData,
		});

		await this.onSample(audioSample);

		this.outputBuffer.fill(0);
		this.maxWrittenFrame = -1;
	}

	finalize() {
		return this.finalizeCurrentBuffer();
	}
}
