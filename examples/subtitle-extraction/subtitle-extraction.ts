/*!
 * Example: Subtitle Extraction
 *
 * This example demonstrates how to extract subtitles from video files
 * using the new subtitle extraction functionality.
 */

import {
	Input,
	SubtitlePacketSink,
	BlobSource,
	ALL_FORMATS,
} from 'mediabunny';

interface SubtitleCue {
	start: number;
	end: number;
	text: string;
}

async function extractSubtitles(file: File) {
	console.log(`Extracting subtitles from: ${file.name}`);

	// Create input from file
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	// Get all subtitle tracks
	const subtitleTracks = await input.getSubtitleTracks();
	console.log(`Found ${subtitleTracks.length} subtitle track(s)`);

	// Process each subtitle track
	for (const track of subtitleTracks) {
		console.log(`\nSubtitle Track ${track.id}:`);
		console.log(`  Language: ${track.languageCode}`);
		console.log(`  Codec: ${track.codec ?? 'unknown'}`);

		// Create a subtitle sink to extract cues
		const sink = new SubtitlePacketSink(track);

		// Extract all subtitle cues
		const cues: SubtitleCue[] = [];
		for await (const cue of sink.subtitles()) {
			cues.push({
				start: cue.timestamp,
				end: cue.timestamp + cue.duration,
				text: cue.text,
			});

			// Log first few cues as examples
			if (cues.length <= 5) {
				const startTime = formatTime(cue.timestamp);
				const endTime = formatTime(cue.timestamp + cue.duration);
				console.log(`  [${startTime} --> ${endTime}] ${cue.text}`);
			}
		}

		console.log(`  Total cues: ${cues.length}`);

		// You could export to SRT, WebVTT, or any other format here
		// For example, to create SRT content:
		const srtContent = cues.map((cue, index) => {
			return `${index + 1}\n${formatSRTTime(cue.start)} --> ${formatSRTTime(cue.end)}\n${cue.text}\n`;
		}).join('\n');

		// Create a download link for the extracted subtitles
		const blob = new Blob([srtContent], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${file.name}_track${track.id}_${track.languageCode}.srt`;
		a.textContent = `Download Track ${track.id} (${track.languageCode})`;
		document.getElementById('output')?.appendChild(a);
		document.getElementById('output')?.appendChild(document.createElement('br'));
	}

	if (subtitleTracks.length === 0) {
		console.log('No subtitle tracks found in this file.');
		const output = document.getElementById('output');
		if (output) {
			output.textContent = 'No subtitle tracks found in this file.';
		}
	}
}

// Helper functions for time formatting
function formatTime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = (seconds % 60).toFixed(3);
	return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.padStart(6, '0')}`;
}

function formatSRTTime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 1000);
	const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:`;
	return `${timeStr}${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// Set up file input handler
document.addEventListener('DOMContentLoaded', () => {
	const fileInput = document.getElementById('fileInput') as HTMLInputElement;
	fileInput?.addEventListener('change', async (event) => {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (file) {
			try {
				await extractSubtitles(file);
			} catch (error) {
				console.error('Error extracting subtitles:', error);
				const output = document.getElementById('output');
				if (output) {
					output.textContent = `Error: ${String(error)}`;
				}
			}
		}
	});
}); 