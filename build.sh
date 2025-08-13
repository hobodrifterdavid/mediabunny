#!/bin/bash
set -e

# This script must be executed via `npm run build`

# Clear the stuff from last build
rm -rf dist
rm -rf packages/mp3-encoder/dist

# Ensure license headers on all source files
tsx scripts/ensure-license-headers.ts

# Type check & generate .js and .d.ts files
tsc -p src
tsc -p packages/mp3-encoder/src

# So that the resulting files use valid ESM imports with file extension. This only runs for the core Mediabunny as only
# it ships the individual files to npm (for tree shaking, because it's large)
npm run fix-build-import-paths

# Creates bundles for all packages
tsx scripts/bundle.ts

# Declaration file rollup and checks
api-extractor run
api-extractor run -c packages/mp3-encoder/api-extractor.json

# Checks that all symbols are documented
tsx scripts/check-docblocks.ts dist/mediabunny.d.ts
tsx scripts/check-docblocks.ts packages/mp3-encoder/dist/mediabunny-mp3-encoder.d.ts

# Appends stuff to the declaration files to register the global variables these libraries expose
echo 'export as namespace Mediabunny;' >> dist/mediabunny.d.ts
echo 'export as namespace MediabunnyMp3Encoder;' >> packages/mp3-encoder/dist/mediabunny-mp3-encoder.d.ts