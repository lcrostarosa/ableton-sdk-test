import { FakeSerum } from "../audio/fakeSerum.ts";
import { measureScalar } from "../../../src/common/measure.ts";
import { safeOf } from "../../../src/common/registry.ts";
import { SERUM_PROFILE } from "../../../src/common/profiles.ts";
import type { Range, SynthProfile } from "../../../src/common/registry.ts";
import type { ScalarAPO } from "../../../src/common/measure.ts";
import type { RecipeAdapter } from "../../../src/common/intentEngine.ts";

const SIM_KEYS = {
  "filter.cutoff": "cutoff",
  "filter.reso": "reso",
  "fx.drive": "drive",
  "sub.level": "subLevel",
  "osc.detune": "detune",
  "lfo1.rate": "lfoRate",
} as const;

type SimControlId = keyof typeof SIM_KEYS;

export class SimAdapter implements RecipeAdapter {
  synth: FakeSerum;
  profile: SynthProfile;

  constructor(profile: SynthProfile = SERUM_PROFILE) {
    this.profile = profile;
    this.synth = new FakeSerum({ f0: 55, sampleRate: 44100, durationSec: 0.7 });
  }

  private knob(id: string): (typeof SIM_KEYS)[SimControlId] {
    const knob = SIM_KEYS[id as SimControlId];
    if (!knob) throw new Error(`SimAdapter has no knob for control id "${id}"`);
    return knob;
  }

  get(id: string): number { return this.synth[this.knob(id)]; }
  set(id: string, v: number): void { this.synth[this.knob(id)] = v; }
  safeOf(id: string): Range { return safeOf(this.profile, id); }

  // FakeSerum renders mono, so no channelData is passed → stereo fields take their mono
  // defaults (width 0, correlation 1). That is correct: a mono source has no stereo image.
  measure(): ScalarAPO {
    const buf = this.synth.render();
    return measureScalar(buf, this.synth.sampleRate, { bands: this.profile.metricBands });
  }
}
