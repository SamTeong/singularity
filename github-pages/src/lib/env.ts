// Ported from docs/one-shot/3d/sample-gitlab-3d-scan.html, source lines 736-738.
//
// These are sampled ONCE at module load, exactly as the original does — they
// deliberately do NOT subscribe to matchMedia change events. The original
// closes over the sampled value in seven places, one of which (the 360-mote
// particle system, built once after the GLB fits against a bbox that only
// exists post-load) has no rebuild path at all. Live subscription would mean
// tearing down and rebuilding the whole experience, not a small behaviour
// change — so a value frozen at load time is the intended contract, not an
// oversight to "fix".

export const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const DEBUG = new URLSearchParams(location.search).has('debug');
export const NARROW = matchMedia('(max-width: 900px)').matches;
