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
	buildAudioCodecString,
	buildVideoCodecString,
	getAudioEncoderConfigExtension,
	getVideoEncoderConfigExtension,
	inferCodecFromCodecString,
	MediaCodec,
	PCM_AUDIO_CODECS,
	Quality,
	SUBTITLE_CODECS,
	SubtitleCodec,
	VIDEO_CODECS,
	VideoCodec,
} from './codec';
import { customAudioEncoders, customVideoEncoders } from './custom-coder';
import { EncodedPacket } from './packet';

/**
 * Configuration object that controls video encoding. Can be used to set codec, quality, and more.
 * @public
 */
export type VideoEncodingConfig = {
	/** The video codec that should be used for encoding the video samples (frames). */
	codec: VideoCodec;
	/**
	 * The target bitrate for the encoded video, in bits per second. Alternatively, a subjective Quality can
	 * be provided.
	 */
	bitrate: number | Quality;
	/**
	 * The interval, in seconds, of how often frames are encoded as a key frame. The default is 5 seconds. Frequent key
	 * frames improve seeking behavior but increase file size. When using multiple video tracks, you should give them
	 * all the same key frame interval.
	 */
	keyFrameInterval?: number;
	/**
	 * Video frames may change size overtime. This field controls the behavior in case this happens.
	 *
	 * - 'deny' (default) will throw an error, requiring all frames to have the exact same dimensions.
	 * - 'passThrough' will allow the change and directly pass the frame to the encoder.
	 * - 'fill' will stretch the image to fill the entire original box, potentially altering aspect ratio.
	 * - 'contain' will contain the entire image within the  originalbox while preserving aspect ratio. This may lead to
	 * letterboxing.
	 * - 'cover' will scale the image until the entire original box is filled, while preserving aspect ratio.
	 *
	 * The "original box" refers to the dimensions of the first encoded frame.
	 */
	sizeChangeBehavior?: 'deny' | 'passThrough' | 'fill' | 'contain' | 'cover';

	/** Called for each successfully encoded packet. Both the packet and the encoding metadata are passed. */
	onEncodedPacket?: (packet: EncodedPacket, meta: EncodedVideoChunkMetadata | undefined) => unknown;
	/** Called when the internal encoder config, as used by the WebCodecs API, is created. */
	onEncoderConfig?: (config: VideoEncoderConfig) => unknown;
} & VideoEncodingAdditionalOptions;

export const validateVideoEncodingConfig = (config: VideoEncodingConfig) => {
	if (!config || typeof config !== 'object') {
		throw new TypeError('Encoding config must be an object.');
	}
	if (!VIDEO_CODECS.includes(config.codec)) {
		throw new TypeError(`Invalid video codec '${config.codec}'. Must be one of: ${VIDEO_CODECS.join(', ')}.`);
	}
	if (!(config.bitrate instanceof Quality) && (!Number.isInteger(config.bitrate) || config.bitrate <= 0)) {
		throw new TypeError('config.bitrate must be a positive integer or a quality.');
	}
	if (
		config.keyFrameInterval !== undefined
		&& (!Number.isFinite(config.keyFrameInterval) || config.keyFrameInterval < 0)
	) {
		throw new TypeError('config.keyFrameInterval, when provided, must be a non-negative number.');
	}
	// todo here
	if (config.onEncodedPacket !== undefined && typeof config.onEncodedPacket !== 'function') {
		throw new TypeError('config.onEncodedChunk, when provided, must be a function.');
	}
	if (config.onEncoderConfig !== undefined && typeof config.onEncoderConfig !== 'function') {
		throw new TypeError('config.onEncoderConfig, when provided, must be a function.');
	}

	validateVideoEncodingAdditionalOptions(config.codec, config);
};

/**
 * Additional options that control audio encoding.
 * @public
 */
export type VideoEncodingAdditionalOptions = {
	/** Configures the bitrate mode. */
	bitrateMode?: 'constant' | 'variable';
	/** The latency mode used by the encoder; controls the performance-quality tradeoff. */
	latencyMode?: VideoEncoderConfig['latencyMode'];
	/**
	 * The full codec string as specified in the WebCodecs Codec Registry. This string must match the codec
	 * specified in `codec`. When not set, a fitting codec string will be constructed automatically by the library.
	 */
	fullCodecString?: string;
	/** A hint that configures the hardware acceleration method of this codec. This is best left on 'no-preference'. */
	hardwareAcceleration?: VideoEncoderConfig['hardwareAcceleration'];
	/**
	 * An encoding scalability mode identifier as defined by
	 * [WebRTC-SVC](https://w3c.github.io/webrtc-svc/#scalabilitymodes*).
	 */
	scalabilityMode?: VideoEncoderConfig['scalabilityMode'];
	/**
	 * An encoding video content hint as defined by
	 * [mst-content-hint](https://w3c.github.io/mst-content-hint/#video-content-hints).
	 */
	contentHint?: VideoEncoderConfig['contentHint'];
};

export const validateVideoEncodingAdditionalOptions = (codec: VideoCodec, options: VideoEncodingAdditionalOptions) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('Encoding options must be an object.');
	}
	if (options.bitrateMode !== undefined && !['constant', 'variable'].includes(options.bitrateMode)) {
		throw new TypeError('bitrateMode, when provided, must be \'constant\' or \'variable\'.');
	}
	if (options.latencyMode !== undefined && !['quality', 'realtime'].includes(options.latencyMode)) {
		throw new TypeError('latencyMode, when provided, must be \'quality\' or \'realtime\'.');
	}
	if (options.fullCodecString !== undefined && typeof options.fullCodecString !== 'string') {
		throw new TypeError('fullCodecString, when provided, must be a string.');
	}
	if (options.fullCodecString !== undefined && inferCodecFromCodecString(options.fullCodecString) !== codec) {
		throw new TypeError(
			`fullCodecString, when provided, must be a string that matches the specified codec (${codec}).`,
		);
	}
	if (
		options.hardwareAcceleration !== undefined
		&& !['no-preference', 'prefer-hardware', 'prefer-software'].includes(options.hardwareAcceleration)
	) {
		throw new TypeError(
			'hardwareAcceleration, when provided, must be \'no-preference\', \'prefer-hardware\' or'
			+ ' \'prefer-software\'.',
		);
	}
	if (options.scalabilityMode !== undefined && typeof options.scalabilityMode !== 'string') {
		throw new TypeError('scalabilityMode, when provided, must be a string.');
	}
	if (options.contentHint !== undefined && typeof options.contentHint !== 'string') {
		throw new TypeError('contentHint, when provided, must be a string.');
	}
};

export const buildVideoEncoderConfig = (options: {
	codec: VideoCodec;
	width: number;
	height: number;
	bitrate: number | Quality;
	framerate: number | undefined;
} & VideoEncodingAdditionalOptions): VideoEncoderConfig => {
	const resolvedBitrate = options.bitrate instanceof Quality
		? options.bitrate._toVideoBitrate(options.codec, options.width, options.height)
		: options.bitrate;

	return {
		codec: options.fullCodecString ?? buildVideoCodecString(
			options.codec,
			options.width,
			options.height,
			resolvedBitrate,
		),
		width: options.width,
		height: options.height,
		bitrate: resolvedBitrate,
		bitrateMode: options.bitrateMode,
		framerate: options.framerate, // this.source._connectedTrack?.metadata.frameRate,
		latencyMode: options.latencyMode,
		hardwareAcceleration: options.hardwareAcceleration,
		scalabilityMode: options.scalabilityMode,
		contentHint: options.contentHint,
		...getVideoEncoderConfigExtension(options.codec),
	};
};

/**
 * Configuration object that controls audio encoding. Can be used to set codec, quality, and more.
 * @public
 */
export type AudioEncodingConfig = {
	/** The audio codec that should be used for encoding the audio samples. */
	codec: AudioCodec;
	/**
	 * The target bitrate for the encoded audio, in bits per second. Alternatively, a subjective Quality can
	 * be provided. Required for compressed audio codecs, unused for PCM codecs.
	 */
	bitrate?: number | Quality;

	/** Called for each successfully encoded packet. Both the packet and the encoding metadata are passed. */
	onEncodedPacket?: (packet: EncodedPacket, meta: EncodedAudioChunkMetadata | undefined) => unknown;
	/** Called when the internal encoder config, as used by the WebCodecs API, is created. */
	onEncoderConfig?: (config: AudioEncoderConfig) => unknown;
} & AudioEncodingAdditionalOptions;

export const validateAudioEncodingConfig = (config: AudioEncodingConfig) => {
	if (!config || typeof config !== 'object') {
		throw new TypeError('Encoding config must be an object.');
	}
	if (!AUDIO_CODECS.includes(config.codec)) {
		throw new TypeError(`Invalid audio codec '${config.codec}'. Must be one of: ${AUDIO_CODECS.join(', ')}.`);
	}
	if (
		config.bitrate === undefined
		&& (!(PCM_AUDIO_CODECS as readonly string[]).includes(config.codec) || config.codec === 'flac')
	) {
		throw new TypeError('config.bitrate must be provided for compressed audio codecs.');
	}
	if (
		config.bitrate !== undefined
		&& !(config.bitrate instanceof Quality)
		&& (!Number.isInteger(config.bitrate) || config.bitrate <= 0)
	) {
		throw new TypeError('config.bitrate, when provided, must be a positive integer or a quality.');
	}
	if (config.onEncodedPacket !== undefined && typeof config.onEncodedPacket !== 'function') {
		throw new TypeError('config.onEncodedChunk, when provided, must be a function.');
	}
	if (config.onEncoderConfig !== undefined && typeof config.onEncoderConfig !== 'function') {
		throw new TypeError('config.onEncoderConfig, when provided, must be a function.');
	}

	validateAudioEncodingAdditionalOptions(config.codec, config);
};

/**
 * Additional options that control audio encoding.
 * @public
 */
export type AudioEncodingAdditionalOptions = {
	/** Configures the bitrate mode. */
	bitrateMode?: 'constant' | 'variable';
	/**
	 * The full codec string as specified in the WebCodecs Codec Registry. This string must match the codec
	 * specified in `codec`. When not set, a fitting codec string will be constructed automatically by the library.
	 */
	fullCodecString?: string;
};

export const validateAudioEncodingAdditionalOptions = (codec: AudioCodec, options: AudioEncodingAdditionalOptions) => {
	if (!options || typeof options !== 'object') {
		throw new TypeError('Encoding options must be an object.');
	}
	if (options.bitrateMode !== undefined && !['constant', 'variable'].includes(options.bitrateMode)) {
		throw new TypeError('bitrateMode, when provided, must be \'constant\' or \'variable\'.');
	}
	if (options.fullCodecString !== undefined && typeof options.fullCodecString !== 'string') {
		throw new TypeError('fullCodecString, when provided, must be a string.');
	}
	if (options.fullCodecString !== undefined && inferCodecFromCodecString(options.fullCodecString) !== codec) {
		throw new TypeError(
			`fullCodecString, when provided, must be a string that matches the specified codec (${codec}).`,
		);
	}
};

export const buildAudioEncoderConfig = (options: {
	codec: AudioCodec;
	numberOfChannels: number;
	sampleRate: number;
	bitrate?: number | Quality;
} & AudioEncodingAdditionalOptions): AudioEncoderConfig => {
	const resolvedBitrate = options.bitrate instanceof Quality
		? options.bitrate._toAudioBitrate(options.codec)
		: options.bitrate;

	return {
		codec: options.fullCodecString ?? buildAudioCodecString(
			options.codec,
			options.numberOfChannels,
			options.sampleRate,
		),
		numberOfChannels: options.numberOfChannels,
		sampleRate: options.sampleRate,
		bitrate: resolvedBitrate,
		bitrateMode: options.bitrateMode,
		...getAudioEncoderConfigExtension(options.codec),
	};
};

/**
 * Checks if the browser is able to encode the given codec.
 * @public
 */
export const canEncode = (codec: MediaCodec) => {
	if ((VIDEO_CODECS as readonly string[]).includes(codec)) {
		return canEncodeVideo(codec as VideoCodec);
	} else if ((AUDIO_CODECS as readonly string[]).includes(codec)) {
		return canEncodeAudio(codec as AudioCodec);
	} else if ((SUBTITLE_CODECS as readonly string[]).includes(codec)) {
		return canEncodeSubtitles(codec as SubtitleCodec);
	}

	throw new TypeError(`Unknown codec '${codec}'.`);
};

/**
 * Checks if the browser is able to encode the given video codec with the given parameters.
 * @public
 */
export const canEncodeVideo = async (codec: VideoCodec, {
	width = 1280,
	height = 720,
	bitrate = 1e6,
	...restOptions
}: {
	width?: number;
	height?: number;
	bitrate?: number | Quality;
} & VideoEncodingAdditionalOptions = {}) => {
	if (!VIDEO_CODECS.includes(codec)) {
		return false;
	}
	if (!Number.isInteger(width) || width <= 0) {
		throw new TypeError('width must be a positive integer.');
	}
	if (!Number.isInteger(height) || height <= 0) {
		throw new TypeError('height must be a positive integer.');
	}
	if (!(bitrate instanceof Quality) && (!Number.isInteger(bitrate) || bitrate <= 0)) {
		throw new TypeError('bitrate must be a positive integer or a quality.');
	}
	validateVideoEncodingAdditionalOptions(codec, restOptions);

	let encoderConfig: VideoEncoderConfig | null = null;

	if (customVideoEncoders.length > 0) {
		encoderConfig ??= buildVideoEncoderConfig({
			codec,
			width,
			height,
			bitrate,
			framerate: undefined,
			...restOptions,
		});

		if (customVideoEncoders.some(x => x.supports(codec, encoderConfig!))) {
			// There's a custom encoder
			return true;
		}
	}

	if (typeof VideoEncoder === 'undefined') {
		return false;
	}

	encoderConfig ??= buildVideoEncoderConfig({
		codec,
		width,
		height,
		bitrate,
		framerate: undefined,
		...restOptions,
	});

	const support = await VideoEncoder.isConfigSupported(encoderConfig);
	return support.supported === true;
};

/**
 * Checks if the browser is able to encode the given audio codec with the given parameters.
 * @public
 */
export const canEncodeAudio = async (codec: AudioCodec, {
	numberOfChannels = 2,
	sampleRate = 48000,
	bitrate = 128e3,
	...restOptions
}: {
	numberOfChannels?: number;
	sampleRate?: number;
	bitrate?: number | Quality;
} & AudioEncodingAdditionalOptions = {}) => {
	if (!AUDIO_CODECS.includes(codec)) {
		return false;
	}
	if (!Number.isInteger(numberOfChannels) || numberOfChannels <= 0) {
		throw new TypeError('numberOfChannels must be a positive integer.');
	}
	if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
		throw new TypeError('sampleRate must be a positive integer.');
	}
	if (!(bitrate instanceof Quality) && (!Number.isInteger(bitrate) || bitrate <= 0)) {
		throw new TypeError('bitrate must be a positive integer.');
	}
	validateAudioEncodingAdditionalOptions(codec, restOptions);

	let encoderConfig: AudioEncoderConfig | null = null;

	if (customAudioEncoders.length > 0) {
		encoderConfig ??= buildAudioEncoderConfig({
			codec,
			numberOfChannels,
			sampleRate,
			bitrate,
			...restOptions,
		});

		if (customAudioEncoders.some(x => x.supports(codec, encoderConfig!))) {
			// There's a custom encoder
			return true;
		}
	}

	if ((PCM_AUDIO_CODECS as readonly string[]).includes(codec)) {
		return true; // Because we encode these ourselves
	}

	if (typeof AudioEncoder === 'undefined') {
		return false;
	}

	encoderConfig ??= buildAudioEncoderConfig({
		codec,
		numberOfChannels,
		sampleRate,
		bitrate,
		...restOptions,
	});

	const support = await AudioEncoder.isConfigSupported(encoderConfig);
	return support.supported === true;
};

/**
 * Checks if the browser is able to encode the given subtitle codec.
 * @public
 */
export const canEncodeSubtitles = async (codec: SubtitleCodec) => {
	if (!SUBTITLE_CODECS.includes(codec)) {
		return false;
	}

	return true;
};

/**
 * Returns the list of all media codecs that can be encoded by the browser.
 * @public
 */
export const getEncodableCodecs = async (): Promise<MediaCodec[]> => {
	const [videoCodecs, audioCodecs, subtitleCodecs] = await Promise.all([
		getEncodableVideoCodecs(),
		getEncodableAudioCodecs(),
		getEncodableSubtitleCodecs(),
	]);

	return [...videoCodecs, ...audioCodecs, ...subtitleCodecs];
};

/**
 * Returns the list of all video codecs that can be encoded by the browser.
 * @public
 */
export const getEncodableVideoCodecs = async (
	checkedCodecs = VIDEO_CODECS as unknown as VideoCodec[],
	options?: {
		width?: number;
		height?: number;
		bitrate?: number | Quality;
	},
): Promise<VideoCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(codec => canEncodeVideo(codec, options)));
	return checkedCodecs.filter((_, i) => bools[i]);
};

/**
 * Returns the list of all audio codecs that can be encoded by the browser.
 * @public
 */
export const getEncodableAudioCodecs = async (
	checkedCodecs = AUDIO_CODECS as unknown as AudioCodec[],
	options?: {
		numberOfChannels?: number;
		sampleRate?: number;
		bitrate?: number | Quality;
	},
): Promise<AudioCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(codec => canEncodeAudio(codec, options)));
	return checkedCodecs.filter((_, i) => bools[i]);
};

/**
 * Returns the list of all subtitle codecs that can be encoded by the browser.
 * @public
 */
export const getEncodableSubtitleCodecs = async (
	checkedCodecs = SUBTITLE_CODECS as unknown as SubtitleCodec[],
): Promise<SubtitleCodec[]> => {
	const bools = await Promise.all(checkedCodecs.map(canEncodeSubtitles));
	return checkedCodecs.filter((_, i) => bools[i]);
};

/**
 * Returns the first video codec from the given list that can be encoded by the browser.
 * @public
 */
export const getFirstEncodableVideoCodec = async (
	checkedCodecs: VideoCodec[],
	options?: {
		width?: number;
		height?: number;
		bitrate?: number | Quality;
	},
): Promise<VideoCodec | null> => {
	for (const codec of checkedCodecs) {
		if (await canEncodeVideo(codec, options)) {
			return codec;
		}
	}

	return null;
};

/**
 * Returns the first audio codec from the given list that can be encoded by the browser.
 * @public
 */
export const getFirstEncodableAudioCodec = async (
	checkedCodecs: AudioCodec[],
	options?: {
		numberOfChannels?: number;
		sampleRate?: number;
		bitrate?: number | Quality;
	},
): Promise<AudioCodec | null> => {
	for (const codec of checkedCodecs) {
		if (await canEncodeAudio(codec, options)) {
			return codec;
		}
	}

	return null;
};

/**
 * Returns the first subtitle codec from the given list that can be encoded by the browser.
 * @public
 */
export const getFirstEncodableSubtitleCodec = async (
	checkedCodecs: SubtitleCodec[],
): Promise<SubtitleCodec | null> => {
	for (const codec of checkedCodecs) {
		if (await canEncodeSubtitles(codec)) {
			return codec;
		}
	}

	return null;
};
