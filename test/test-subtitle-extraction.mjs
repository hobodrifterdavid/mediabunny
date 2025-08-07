#!/usr/bin/env node

/**
 * Test script for subtitle extraction functionality
 * 
 * Usage:
 *   node test/test-subtitle-extraction.mjs <video-file>
 * 
 * Example:
 *   node test/test-subtitle-extraction.mjs movie.mkv
 *   node test/test-subtitle-extraction.mjs video.mp4
 */

import { Input, SubtitlePacketSink, BlobSource, ALL_FORMATS } from '../dist/modules/index.js';
import fs from 'fs/promises';
import path from 'path';

async function testSubtitleExtraction(filePath) {
	console.log(`\n🎬 Testing subtitle extraction for: ${path.basename(filePath)}`);
	console.log('=' .repeat(60));
	
	try {
		// Read the file
		const fileBuffer = await fs.readFile(filePath);
		const blob = new Blob([fileBuffer]);
		
		// Create input
		const input = new Input({
			source: new BlobSource(blob),
			formats: ALL_FORMATS,
		});
		
		// Get all tracks
		const tracks = await input.getTracks();
		console.log('Got tracks:', tracks.length);
		const videoTracks = tracks.filter(t => t.isVideoTrack());
		const audioTracks = tracks.filter(t => t.isAudioTrack());
		const subtitleTracks = tracks.filter(t => t.isSubtitleTrack());
		console.log('Filtered tracks - video:', videoTracks.length, 'audio:', audioTracks.length, 'subtitle:', subtitleTracks.length);
		
		console.log('\n📊 Track Summary:');
		console.log(`  Total tracks: ${tracks.length}`);
		console.log(`  Video tracks: ${videoTracks.length}`);
		console.log(`  Audio tracks: ${audioTracks.length}`);
		console.log(`  Subtitle tracks: ${subtitleTracks.length}`);
		
		// Show video track metadata
		if (videoTracks.length > 0) {
			console.log('\n🎥 Video Tracks:');
			for (const track of videoTracks) {
				console.log(`\n  Track (ID: ${track.id}):`);
				console.log(`    Codec: ${track.codec || `unknown (${track.codecId || 'no codec ID'})`}`);
				console.log(`    Dimensions: ${track.codedWidth}x${track.codedHeight}`);
				console.log(`    Language (ISO 639-2): ${track.languageCode || 'unknown'}`);
				console.log(`    Language (BCP 47): ${track.languageBCP47 || 'not specified'}`);
				console.log(`    Name: ${track.name || 'untitled'}`);
				console.log(`    Default: ${track.isDefault}`);
				console.log(`    Forced: ${track.isForced}`);
				if (track.defaultDuration) {
					const fps = 1000000000 / track.defaultDuration;
					console.log(`    Frame rate: ${fps.toFixed(2)} fps (from default duration)`);
				}
				console.log(`    Codec delay: ${track.codecDelay / 1000000}ms`);
				console.log(`    Seek pre-roll: ${track.seekPreRoll / 1000000}ms`);
			}
		}
		
		// Show audio track metadata
		if (audioTracks.length > 0) {
			console.log('\n🔊 Audio Tracks:');
			for (const track of audioTracks) {
				console.log(`\n  Track (ID: ${track.id}):`);
				console.log(`    Codec: ${track.codec || `unknown (${track.codecId || 'no codec ID'})`}`);
				console.log(`    Channels: ${track.numberOfChannels}`);
				console.log(`    Sample rate: ${track.sampleRate} Hz`);
				console.log(`    Bit depth: ${track.bitDepth || 'not specified'}`);
				console.log(`    Language (ISO 639-2): ${track.languageCode || 'unknown'}`);
				console.log(`    Language (BCP 47): ${track.languageBCP47 || 'not specified'}`);
				console.log(`    Name: ${track.name || 'untitled'}`);
				console.log(`    Default: ${track.isDefault}`);
				console.log(`    Forced: ${track.isForced}`);
				console.log(`    Codec delay: ${track.codecDelay / 1000000}ms`);
				console.log(`    Seek pre-roll: ${track.seekPreRoll / 1000000}ms`);
			}
		}
		
		if (subtitleTracks.length === 0) {
			console.log('\n⚠️  No subtitle tracks found in this file.');
			return;
		}
		
		// Process each subtitle track
		console.log('\n📝 Subtitle Tracks:');
		for (let i = 0; i < subtitleTracks.length; i++) {
			const track = subtitleTracks[i];
			console.log(`\n  Track ${i + 1} (ID: ${track.id}):`);
			console.log(`    Language (ISO 639-2): ${track.languageCode || 'unknown'}`);
			console.log(`    Language (BCP 47): ${track.languageBCP47 || 'not specified'}`);
			console.log(`    Codec: ${track.codec || `unknown (${track.codecId || 'no codec ID'})`}`);
			console.log(`    Name: ${track.name || 'untitled'}`);
			console.log(`    Default: ${track.isDefault}`);
			console.log(`    Forced: ${track.isForced}`);
			
			// Extract first few subtitle cues
			const sink = new SubtitlePacketSink(track);
			const cues = [];
			
			console.log(`\n    First 5 subtitle cues:`);
			for await (const cue of sink.subtitles()) {
				cues.push(cue);
				if (cues.length <= 5) {
					const start = formatTime(cue.timestamp);
					const end = formatTime(cue.timestamp + cue.duration);
					console.log(`      [${start} --> ${end}]`);
					console.log(`      ${cue.text.replace(/\n/g, ' ')}\n`);
				}
				if (cues.length >= 10) break; // Limit for performance
			}
			
			console.log(`    Total cues extracted: ${cues.length}${cues.length >= 10 ? ' (limited to 10)' : ''}`);
			
			// Optionally save to SRT file
			if (process.argv.includes('--save')) {
				const srtContent = cues.map((cue, index) => {
					const start = formatSRTTime(cue.timestamp);
					const end = formatSRTTime(cue.timestamp + cue.duration);
					return `${index + 1}\n${start} --> ${end}\n${cue.text}\n`;
				}).join('\n');
				
				const outputName = `${path.basename(filePath, path.extname(filePath))}_track${track.id}_${track.languageCode || 'unknown'}.srt`;
				await fs.writeFile(outputName, srtContent);
				console.log(`    ✅ Saved to: ${outputName}`);
			}
		}
		
		if (process.argv.includes('--save')) {
			console.log('\n💾 Use --save flag to export subtitle tracks to SRT files');
		}
		
	} catch (error) {
		console.error('\n❌ Error:', error.message);
		if (error.stack && process.argv.includes('--debug')) {
			console.error(error.stack);
		}
	}
}

// Helper functions
function formatTime(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = (seconds % 60).toFixed(3);
	return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.padStart(6, '0')}`;
}

function formatSRTTime(seconds) {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 1000);
	return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// Main
async function main() {
	if (process.argv.length < 3) {
		console.log('Usage: node test-subtitle-extraction.mjs <video-file> [--save] [--debug]');
		console.log('\nOptions:');
		console.log('  --save   Export subtitle tracks to SRT files');
		console.log('  --debug  Show detailed error information');
		console.log('\nExample:');
		console.log('  node test-subtitle-extraction.mjs movie.mkv --save');
		process.exit(1);
	}

	const filePath = process.argv[2];
	await testSubtitleExtraction(filePath);
}

// Run with timeout
const timeoutPromise = new Promise((_, reject) => {
	setTimeout(() => reject(new Error('Operation timed out after 30 seconds')), 30000);
});

Promise.race([main(), timeoutPromise])
	.catch(err => {
		console.error('\n❌ Error:', err.message);
		if (err.stack && process.argv.includes('--debug')) {
			console.error(err.stack);
		}
		process.exit(1);
	}); 