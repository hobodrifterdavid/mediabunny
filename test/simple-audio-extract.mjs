#!/usr/bin/env node

/*
 * Simple MediaBunny Audio Extractor
 * ---------------------------------
 * • Uses the original `mediabunny` package only
 * • Scans a directory (recursive) for *.mkv, *.mp4, *.webm files
 * • Prints basic analysis (audio track info)
 * • Extracts each audio track into a reasonable container or raw file
 *
 * Usage: node simple-audio-extract.mjs <input-folder>
 *   --force   re-process even if output file already exists
 *
 * Output is written next to the video file in a sub-directory named `<video>.audio`.
 */

import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

import {
  Input,
  StreamSource,
  ALL_FORMATS,
  EncodedPacketSink,
  Conversion,
  Output,
  BufferTarget,
  Mp4OutputFormat,
  WebMOutputFormat,
  OggOutputFormat,
  MkvOutputFormat,
} from "mediabunny";

const execAsync = promisify(exec);

const SUPPORTED_EXT = [".mkv", ".mp4", ".webm"];
const MIN_SIZE = 100 * 1024 * 1024; // 100 MB

const CODEC_MAP = {
  aac: { format: Mp4OutputFormat, ext: "mp4" },
  opus: { format: WebMOutputFormat, ext: "webm" },
  vorbis: { format: OggOutputFormat, ext: "ogg" },
  mp3: { format: null, ext: "mp3" },
  ac3: { format: null, ext: "ac3" },
  eac3: { format: null, ext: "eac3" },
  dts: { format: null, ext: "dts" },
  truehd: { format: null, ext: "thd" },
  flac: { format: null, ext: "flac" },
  default: { format: MkvOutputFormat, ext: "mkv" },
};

function bytesFmt(b) {
  if (!b) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function validate(file) {
  try {
    const { stdout } = await execAsync(`ffprobe -v error -show_format -of json "${file}"`);
    const info = JSON.parse(stdout);
    return { ok: true, duration: info.format.duration };
  } catch {
    return { ok: false };
  }
}

async function analyzeAndExtract(video, force) {
  const stat = await fs.stat(video);
  const ext = path.extname(video).toLowerCase();
  if (!SUPPORTED_EXT.includes(ext) || stat.size < MIN_SIZE) return;

  console.log(`\n=== ${path.basename(video)} (${bytesFmt(stat.size)}) ===`);

  // output directory
  const outDir = `${video}.audio`;
  await fs.mkdir(outDir, { recursive: true });

  const fh = await fs.open(video, "r");
  const streamSource = new StreamSource({
    read: async (s, e) => {
      const buf = Buffer.allocUnsafe(e - s);
      const { bytesRead } = await fh.read(buf, 0, e - s, s);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    },
    getSize: async () => stat.size,
  });

  const input = new Input({ source: streamSource, formats: ALL_FORMATS });
  const audioTracks = await input.getAudioTracks();
  console.log(`Audio tracks: ${audioTracks.length}`);

  for (let i = 0; i < audioTracks.length; i++) {
    const t = audioTracks[i];
    const codec = t.codec || "unknown";
    console.log(`  Track ${i}: ${codec}, ${t.sampleRate} Hz, ${t.numberOfChannels} ch`);

    const map = CODEC_MAP[codec] || CODEC_MAP.default;
    const outFile = path.join(outDir, `track_${i}_${codec}.${map.ext}`);
    if (!force) {
      try {
        await fs.access(outFile);
        console.log(`    → skip (exists)`);
        continue;
      } catch {}
    }

    if (map.format === null) {
      // raw concat
      const sink = new EncodedPacketSink(t);
      const chunks = [];
      let total = 0;
      for await (const pkt of sink.packets()) {
        chunks.push(pkt.data);
        total += pkt.data.length;
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      await fs.writeFile(outFile, merged);
      console.log(`    → raw saved (${bytesFmt(total)})`);
    } else {
      const target = new BufferTarget();
      const output = new Output({ format: new map.format(), target });
      const conv = await Conversion.init({ input, output, tracks: { indices: [i], audioOnly: true }, video: { discard: true } });
      await conv.execute();
      await fs.writeFile(outFile, new Uint8Array(target.buffer));
      console.log(`    → container saved (${bytesFmt(target.buffer.byteLength)})`);
    }

    const v = await validate(outFile);
    console.log(`      validate: ${v.ok ? "OK" : "FAIL"}${v.duration ? ` (${Number(v.duration).toFixed(1)} s)` : ""}`);
  }

  await fh.close();
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const folder = path.resolve(args.filter((a) => a !== "--force")[0] || ".");
  const start = Date.now();

  console.log(`Scanning ${folder} …`);
  let count = 0;
  for await (const file of walk(folder)) {
    await analyzeAndExtract(file, force);
    count++;
  }
  console.log(`\nDone. Processed ${count} file(s) in ${((Date.now() - start) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}); 