# Acquisition Gate Report

Filename metadata available: YES

## Gates

| Capability ID | Capability | Status | Reason | Evidence | Details |
| --- | --- | --- | --- | --- | --- |
| serum-preset-metadata-parse | .SerumPreset metadata parse | FAIL | Fixture mode does not parse proprietary .SerumPreset payloads. | .sisyphus/evidence/task-2-fallback-fixture.txt | Filename/folder metadata remains available. |
| ableton-device-parameter-snapshot | Ableton device parameter snapshot | PASS | Fake Live rig exposes Serum2 parameters through DeviceParameter.getValue(). | liveAdapter.test.ts | Fixture captures normalized parameter snapshots without Ableton. |
| ableton-audio-render-capture | Audio-track render capture | PASS | Fake Live rig renders the routed AI Ear track through renderPreFxAudio. | liveAdapter.test.ts | Fixture render path produces deterministic WAV output. |
| manual-current-preset-capture | Manual/current-preset capture | PASS | Fixture inputs allow the currently loaded preset to be identified manually. | .sisyphus/evidence/task-2-fallback-fixture.txt | Used when automatic enumeration/loading is unavailable. |
| max-for-live-preset-probe | Max for Live preset probe | FAIL | No proven PluginDevice.presets fixture exists for this repository. | .sisyphus/evidence/task-2-fallback-fixture.txt | Enumeration/loading remains optional and unproven. |

## Fallback Selection

- Capture path: manual/current-preset capture
- Metadata path: filename/folder metadata
- Feature sources: filename-folder-metadata, ableton-parameter-snapshot, ableton-audio-render
- Parameter similarity: enabled
- Audio similarity: enabled
- Audio features missing: NO
- Parameter features missing: NO

## Notes

- Automatic preset enumeration/loading is unavailable, so manual/current-preset capture is selected.
- Direct .SerumPreset parsing is unavailable, so indexing falls back to filename/folder metadata only.

# Minimal Fallback Scenario

# Acquisition Gate Report

Filename metadata available: YES

## Gates

| Capability ID | Capability | Status | Reason | Evidence | Details |
| --- | --- | --- | --- | --- | --- |
| serum-preset-metadata-parse | .SerumPreset metadata parse | FAIL | No parser is implemented in this task. | .sisyphus/evidence/task-2-fallback-minimal.txt | - |
| ableton-device-parameter-snapshot | Ableton device parameter snapshot | FAIL | No live device snapshot is available in the minimal fixture. | .sisyphus/evidence/task-2-fallback-minimal.txt | - |
| ableton-audio-render-capture | Audio-track render capture | FAIL | No routed audio render lane is available in the minimal fixture. | .sisyphus/evidence/task-2-fallback-minimal.txt | - |
| manual-current-preset-capture | Manual/current-preset capture | FAIL | No manually loaded current preset is available in the minimal fixture. | .sisyphus/evidence/task-2-fallback-minimal.txt | - |
| max-for-live-preset-probe | Max for Live preset probe | FAIL | No Max for Live preset probe is available in the minimal fixture. | .sisyphus/evidence/task-2-fallback-minimal.txt | - |

## Fallback Selection

- Capture path: metadata-only indexing
- Metadata path: filename/folder metadata
- Feature sources: filename-folder-metadata
- Parameter similarity: disabled
- Audio similarity: disabled
- Audio features missing: YES
- Parameter features missing: YES

## Notes

- Direct .SerumPreset parsing is unavailable, so indexing falls back to filename/folder metadata only.
- Audio render is unavailable for this path (FAIL: No routed audio render lane is available in the minimal fixture.), so audio features are marked missing.
- Parameter snapshot is unavailable for this path (FAIL: No live device snapshot is available in the minimal fixture.), so parameter similarity is disabled.
- No automatic or manual capture path is available, so indexing degrades to metadata-only.