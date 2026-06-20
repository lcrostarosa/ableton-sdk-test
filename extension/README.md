# Ableton path for Serum preset classification v1

This folder only matters when you have a real Ableton plus Serum rig. The repo's verified baseline is still fixture mode from the root `README.md`.

## What this live path currently supports

- finding the Serum device already loaded on a Live track
- reading a normalized parameter snapshot for the currently loaded preset
- rendering from a separate routed audio track named `AI Ear`
- feeding that audio into the same local similarity and classification pipeline used by the fixture proof

What it does not prove:

- automatic Serum library import
- Serum browser automation
- guaranteed `.SerumPreset` payload parsing

Manual capture here means current-loaded-preset capture only.

## Before you trust the live path

Two constraints are already reflected in the source and tests:

- Serum parameters are only usable if Live exposes them to the SDK
- `renderPreFxAudio` is treated as an audio-track render lane, so the measured path uses a routed `AI Ear` track rather than Serum's MIDI track directly

The root docs stay honest about this because the hardware path is not what the committed tests prove. The committed tests prove the fixture doubles and the gating logic.

## Minimal live workflow

1. Load the Serum preset you want to inspect in Ableton.
2. Make sure the device parameters you care about are exposed to Live.
3. Route the instrument into an audio track whose name contains `AI Ear`.
4. Capture the current-loaded preset metadata and parameter snapshot.
5. Render audio from `AI Ear` if the session is set up for it.
6. Add that captured record to a local machine corpus under `.serum-corpus/`.
7. Run the report CLI against the local or fixture corpus.

For the committed fixture proof, the command is still:

```bash
node runPresetReport.ts --corpus test/fixtures/preset-corpus/small-corpus.json --query preset-001
```

## Local outputs

The default report path is `.serum-corpus/reports/latest.json`.

Treat `.serum-corpus/` as machine-local working data. Don't commit local corpora, reports, indexes, rendered audio, or proprietary presets.

## Troubleshooting

### Missing audio render

If render capture fails, confirm you are rendering from the routed `AI Ear` audio track, not directly from Serum's MIDI track. The live adapter code and prior spike notes assume the routed audio lane.

If audio still is not available, the pipeline can still fall back to metadata and parameter signals. You can keep working, but the result is a partial record.

### Missing parameters

If Serum parameters are missing, first verify that the needed controls are exposed in Live. Without those parameters, V1 can still fall back to filename or manual metadata, but it will not invent a parameter snapshot.

### Failed `.SerumPreset` parse

If `.SerumPreset` payload parsing is unavailable or fails, fall back to filename and folder metadata. V1 does not guarantee parser success and does not require it for the documented fixture path.

## Keep expectations tight

This extension-side path is an optional live capture lane. The proven V1 story in this repo is still the gated local corpus pipeline, the sanitized fixture corpus, and the similarity report written to `.serum-corpus/reports/latest.json`.
