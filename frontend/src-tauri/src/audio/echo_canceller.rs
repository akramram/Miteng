// audio/echo_canceller.rs
//
// Acoustic echo cancellation for the microphone track.
//
// Adapted from praveenVnktsh/minutes (MIT), `frontend/src-tauri/src/audio/echo_canceller.rs`.
//
// Mic and system audio are transcribed separately (live, and post-call from
// `mic.mp4` / `system.mp4`). When the remote party plays through laptop
// speakers, the microphone hears them too, so their speech is transcribed once
// as "Guest" and again as "You", and the mixed recording carries a doubled,
// roomy copy of it. `MicEchoCanceller` removes that echo from the mic using the
// system audio as the far-end reference, via WebRTC's AEC3 (pure-Rust `sonora`
// port), echo canceller only: RNNoise and EBU R128 already run at capture.
//
// # Why the mic is held back
//
// AEC3 can only cancel echo that shows up in the capture stream *after* its
// reference arrived. On the pipeline's timeline the opposite can happen: system
// audio reaches the pipeline later than its echo reaches the mic (measured
// upstream: 30-90ms). So each system frame is paired with the mic frame from
// `REFERENCE_LEAD_MS` earlier. The lead is created with priming silence that is
// processed but never returned, so every cleaned sample comes back at its
// original position: the output is the input, delayed in wall-clock time only.
//
// The system audio is delayed by exactly the same amount, so callers always get
// equal-length, still-aligned mic/system pairs for VAD, the per-source tracks,
// and the mix. `flush` returns the held-back tail of both.

use log::{info, warn};
use sonora::config::EchoCanceller;
use sonora::{AudioProcessing, Config, StreamConfig};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

/// Labs switch, persisted in the data root. On unless the user turned it off;
/// read once per recording when the pipeline starts.
static ENABLED: LazyLock<AtomicBool> = LazyLock::new(|| {
    let enabled = std::fs::read_to_string(enabled_path())
        .map(|value| value.trim() != "false")
        .unwrap_or(true);
    AtomicBool::new(enabled)
});

fn enabled_path() -> std::path::PathBuf {
    crate::paths::install_data_root().join("echo_cancellation_enabled.txt")
}

pub fn echo_cancellation_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn get_echo_cancellation_enabled() -> bool {
    echo_cancellation_enabled()
}

#[tauri::command]
pub fn set_echo_cancellation_enabled(enabled: bool) -> Result<(), String> {
    let file = enabled_path();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(file, if enabled { "true" } else { "false" })
        .map_err(|error| error.to_string())?;
    ENABLED.store(enabled, Ordering::Relaxed);
    Ok(())
}

/// How far ahead of the mic the system reference is fed, in milliseconds.
///
/// Covers the pipeline's worst mic-before-system skew with room to spare while
/// leaving the real acoustic delay inside AEC3's delay-estimator range. It is
/// also the extra wall-clock latency of both sources, negligible next to the
/// time a VAD segment takes to close.
pub const REFERENCE_LEAD_MS: usize = 200;

/// AEC3's own processing delay (block framing plus band-split filtering),
/// independent of the audio. 9ms is 432 samples at 48kHz; the timeline test
/// fails if a `sonora` upgrade changes it.
const PROCESSING_LATENCY_MS: usize = 9;

/// How often AEC statistics are logged, in processed frames (10ms each).
const STATS_LOG_INTERVAL_FRAMES: u64 = 6_000;

/// Removes speaker echo from the microphone, using system audio as the reference.
///
/// Feed it aligned, equal-length mic/system windows. It returns the cleaned mic
/// and the matching system samples, equal in length and still aligned, with the
/// last [`REFERENCE_LEAD_MS`] (plus AEC3's ~9ms) held back until the next call or
/// [`flush`]. Every sample fed in comes out exactly once.
///
/// If the processor ever reports an error it logs once and passes the mic
/// through unchanged, so recording never stops because of echo cancellation.
///
/// [`flush`]: MicEchoCanceller::flush
pub struct MicEchoCanceller {
    /// `None` once the processor has failed: the mic then passes through.
    processor: Option<AudioProcessing>,
    /// Stands in for AEC3's processing delay after a fallback to passthrough.
    passthrough_delay: VecDeque<f32>,
    /// Samples per 10ms frame, the only frame size AEC3 accepts.
    frame_len: usize,
    /// Mic samples the reference is fed ahead by; a whole number of frames.
    lead_samples: usize,
    /// [`PROCESSING_LATENCY_MS`] in samples.
    latency_samples: usize,
    /// Mic samples waiting to be cleaned, starting with the priming silence.
    mic: VecDeque<f32>,
    /// System samples waiting to be fed as the reference.
    system: VecDeque<f32>,
    /// System samples waiting to be returned alongside their cleaned mic.
    system_out: VecDeque<f32>,
    /// Output samples still to drop: the priming silence and AEC3's latency.
    skip_left: usize,
    /// Real mic samples fed in, and returned, since the last flush.
    fed: usize,
    returned: usize,
    render_frame: Vec<f32>,
    /// Render output AEC3 insists on writing; never read.
    render_scratch: Vec<f32>,
    capture_frame: Vec<f32>,
    cleaned_frame: Vec<f32>,
    frames_processed: u64,
}

impl MicEchoCanceller {
    /// Create a canceller for mono audio at `sample_rate`.
    pub fn new(sample_rate: u32) -> Self {
        let frame_len = (sample_rate / 100) as usize;
        let lead_frames = REFERENCE_LEAD_MS / 10;
        let stream = StreamConfig::new(sample_rate, 1);
        let processor = AudioProcessing::builder()
            .config(Config {
                echo_canceller: Some(EchoCanceller::default()),
                ..Default::default()
            })
            .capture_config(stream)
            .render_config(stream)
            .build();

        info!(
            "Mic echo canceller ready: AEC3 at {} Hz, reference leads mic by {}ms",
            sample_rate, REFERENCE_LEAD_MS
        );

        let mut canceller = Self {
            processor: Some(processor),
            passthrough_delay: VecDeque::new(),
            frame_len,
            lead_samples: lead_frames * frame_len,
            latency_samples: sample_rate as usize * PROCESSING_LATENCY_MS / 1000,
            mic: VecDeque::new(),
            system: VecDeque::new(),
            system_out: VecDeque::new(),
            skip_left: 0,
            fed: 0,
            returned: 0,
            render_frame: vec![0.0; frame_len],
            render_scratch: vec![0.0; frame_len],
            capture_frame: vec![0.0; frame_len],
            cleaned_frame: vec![0.0; frame_len],
            frames_processed: 0,
        };
        canceller.prime();
        canceller
    }

    /// Clean one aligned window. Returns `(cleaned_mic, system)` for the samples
    /// that are ready; shorter than the input on the first call after creation
    /// or a flush.
    pub fn process(&mut self, mic: &[f32], system: &[f32]) -> (Vec<f32>, Vec<f32>) {
        debug_assert_eq!(mic.len(), system.len(), "mic/system windows must be aligned");
        self.mic.extend(mic.iter().copied());
        self.system.extend(system.iter().copied());
        self.system_out.extend(system.iter().copied());
        self.fed += mic.len();

        let mut out = Vec::with_capacity(mic.len());
        while self.system.len() >= self.frame_len
            && self.mic.len() >= self.lead_samples + self.frame_len
        {
            self.process_frame(&mut out);
        }
        let system_out = self.take_system(out.len());
        (out, system_out)
    }

    /// Return every held-back sample pair, cleaned, and start over on a fresh
    /// lead. Called when the pipeline flushes (pause, stop, timeline reset), so
    /// the end of an utterance reaches the VAD before it is flushed.
    ///
    /// The adaptive filter is kept: the echo path is the same room after a pause.
    pub fn flush(&mut self) -> (Vec<f32>, Vec<f32>) {
        let mut out = Vec::new();

        // Keep feeding (silence once the queues run dry) until AEC3's latency
        // has pushed the last real mic sample out.
        while self.returned < self.fed {
            self.process_frame(&mut out);
        }
        // The last frame can run past the end of the real audio into silence.
        out.truncate(out.len() - (self.returned - self.fed));

        let system_out = self.take_system(out.len());
        self.mic.clear();
        self.system.clear();
        self.system_out.clear();
        self.prime();
        (out, system_out)
    }

    fn take_system(&mut self, len: usize) -> Vec<f32> {
        let mut system: Vec<f32> = self
            .system_out
            .drain(..len.min(self.system_out.len()))
            .collect();
        system.resize(len, 0.0);
        system
    }

    /// Queue `lead_samples` of silence ahead of the mic. It is processed so the
    /// reference gets its lead, and its output is dropped along with AEC3's
    /// latency.
    fn prime(&mut self) {
        self.mic.extend(std::iter::repeat(0.0).take(self.lead_samples));
        self.skip_left = self.lead_samples + self.latency_samples;
        self.fed = 0;
        self.returned = 0;
    }

    /// Run the next render and capture frames through AEC3, zero-padding either
    /// stream when it runs short, and append the cleaned samples to `out`.
    fn process_frame(&mut self, out: &mut Vec<f32>) {
        for sample in self.render_frame.iter_mut() {
            *sample = self.system.pop_front().unwrap_or(0.0);
        }
        for sample in self.capture_frame.iter_mut() {
            *sample = self.mic.pop_front().unwrap_or(0.0);
        }

        if let Some(processor) = self.processor.as_mut() {
            let result = processor
                .process_render_f32(&[&self.render_frame], &mut [&mut self.render_scratch])
                .and_then(|_| {
                    processor.process_capture_f32(
                        &[&self.capture_frame],
                        &mut [&mut self.cleaned_frame],
                    )
                });
            if let Err(e) = result {
                warn!(
                    "Mic echo canceller failed ({:?}); passing the mic through uncancelled from now on",
                    e
                );
                self.processor = None;
                self.passthrough_delay =
                    std::iter::repeat(0.0).take(self.latency_samples).collect();
            }
        }
        if self.processor.is_none() {
            self.passthrough_delay
                .extend(self.capture_frame.iter().copied());
            for sample in self.cleaned_frame.iter_mut() {
                *sample = self.passthrough_delay.pop_front().unwrap_or(0.0);
            }
        }

        self.frames_processed += 1;
        if self.frames_processed % STATS_LOG_INTERVAL_FRAMES == 0 {
            self.log_stats();
        }

        let skip = self.skip_left.min(self.frame_len);
        self.skip_left -= skip;
        let before = out.len();
        out.extend_from_slice(&self.cleaned_frame[skip..]);
        self.returned += out.len() - before;
    }

    fn log_stats(&self) {
        if let Some(processor) = self.processor.as_ref() {
            let stats = processor.statistics();
            info!(
                "Mic echo canceller: ERLE={:?} dB, ERL={:?} dB, estimated delay={:?}ms",
                stats.echo_return_loss_enhancement, stats.echo_return_loss, stats.delay_ms
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    const WINDOW: usize = 2_400; // the pipeline's 50ms mixing window

    /// Deterministic speech-like signal: noise shaped into syllable-length bursts.
    fn speech_like(seconds: f32, seed: u32) -> Vec<f32> {
        let len = (seconds * RATE as f32) as usize;
        let mut state = seed.wrapping_mul(2_654_435_761).max(1);
        let mut lowpass = 0.0f32;
        (0..len)
            .map(|i| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let noise = (state as f32 / u32::MAX as f32) * 2.0 - 1.0;
                lowpass = 0.6 * lowpass + 0.4 * noise;
                let t = i as f32 / RATE as f32;
                let syllable = (t * 4.0 * std::f32::consts::PI).sin().max(0.0);
                let phrase = if (t * 0.7).fract() < 0.8 { 1.0 } else { 0.0 };
                0.3 * lowpass * syllable * phrase
            })
            .collect()
    }

    /// What the mic hears of `system` through speakers and a room, shifted by
    /// `shift` samples (positive: the mic copy appears later on the timeline).
    fn room_echo(system: &[f32], shift: isize) -> Vec<f32> {
        let taps = [(0usize, 0.35f32), (180, 0.12), (610, 0.05)];
        (0..system.len())
            .map(|i| {
                taps.iter()
                    .map(|&(delay, gain)| {
                        let j = i as isize - shift - delay as isize;
                        if j >= 0 && (j as usize) < system.len() {
                            gain * system[j as usize]
                        } else {
                            0.0
                        }
                    })
                    .sum()
            })
            .collect()
    }

    fn run(canceller: &mut MicEchoCanceller, mic: &[f32], system: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let mut mic_out = Vec::with_capacity(mic.len());
        let mut sys_out = Vec::with_capacity(system.len());
        for (m, s) in mic.chunks(WINDOW).zip(system.chunks(WINDOW)) {
            let (cm, cs) = canceller.process(m, s);
            assert_eq!(cm.len(), cs.len());
            mic_out.extend(cm);
            sys_out.extend(cs);
        }
        let (cm, cs) = canceller.flush();
        assert_eq!(cm.len(), cs.len());
        mic_out.extend(cm);
        sys_out.extend(cs);
        (mic_out, sys_out)
    }

    fn energy(samples: &[f32]) -> f64 {
        samples.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() + 1e-12
    }

    fn reduction_db(before: &[f32], after: &[f32]) -> f64 {
        10.0 * (energy(before) / energy(after)).log10()
    }

    fn converged_suppression_db(shift: isize) -> f64 {
        let system = speech_like(16.0, 7);
        let mic = room_echo(&system, shift);
        let mut canceller = MicEchoCanceller::new(RATE);
        let (cleaned, _) = run(&mut canceller, &mic, &system);
        assert_eq!(cleaned.len(), mic.len());
        let tail = 6 * RATE as usize;
        reduction_db(&mic[mic.len() - tail..], &cleaned[cleaned.len() - tail..])
    }

    #[test]
    fn suppresses_echo_that_reaches_the_pipeline_before_its_reference() {
        let db = converged_suppression_db(-(RATE as isize) * 60 / 1000);
        assert!(db >= 15.0, "only {:.1} dB of echo removed", db);
    }

    #[test]
    fn suppresses_echo_that_trails_its_reference() {
        let db = converged_suppression_db(RATE as isize * 40 / 1000);
        assert!(db >= 15.0, "only {:.1} dB of echo removed", db);
    }

    #[test]
    fn near_end_speech_passes_when_nothing_is_playing() {
        let mic = speech_like(6.0, 11);
        let system = vec![0.0; mic.len()];
        let mut canceller = MicEchoCanceller::new(RATE);
        let (cleaned, _) = run(&mut canceller, &mic, &system);
        assert_eq!(cleaned.len(), mic.len());
        let db = reduction_db(&mic, &cleaned);
        assert!(db.abs() < 3.0, "near-end speech changed by {:.1} dB", db);
    }

    #[test]
    fn near_end_speech_survives_after_the_filter_has_converged() {
        let far = speech_like(10.0, 7);
        let near = speech_like(4.0, 23);
        let mut system = far.clone();
        system.extend(vec![0.0; near.len()]);
        let mut mic = room_echo(&far, 0);
        mic.extend(near.iter().copied());

        let mut canceller = MicEchoCanceller::new(RATE);
        let (cleaned, _) = run(&mut canceller, &mic, &system);
        let start = far.len();
        let db = reduction_db(&near, &cleaned[start..start + near.len()]);
        assert!(db < 3.0, "local speech lost {:.1} dB after convergence", db);
    }

    #[test]
    fn cleaned_audio_keeps_its_position_on_the_timeline() {
        let mut mic = vec![0.0f32; 3 * RATE as usize];
        let burst_at = 100_003;
        for (k, sample) in speech_like(0.2, 5).into_iter().enumerate() {
            mic[burst_at + k] = sample * 3.0;
        }
        let system = vec![0.0; mic.len()];
        let mut canceller = MicEchoCanceller::new(RATE);
        let (cleaned, _) = run(&mut canceller, &mic, &system);
        assert_eq!(cleaned.len(), mic.len());

        let burst = &mic[burst_at..burst_at + 9_600];
        let correlation = |lag: isize| -> f64 {
            burst
                .iter()
                .enumerate()
                .map(|(k, &x)| x as f64 * cleaned[(burst_at as isize + lag) as usize + k] as f64)
                .sum()
        };
        let shift = (-2_400..=2_400isize)
            .max_by(|&a, &b| correlation(a).total_cmp(&correlation(b)))
            .unwrap();
        assert!(shift.abs() <= 4, "burst moved by {} samples", shift);
    }

    #[test]
    fn system_output_is_the_unmodified_input_in_order() {
        // The system track must come back bit-exact and in step with the mic,
        // so mic.mp4, system.mp4 and the mix stay aligned.
        let system = speech_like(2.0, 3);
        let mic = room_echo(&system, 0);
        let mut canceller = MicEchoCanceller::new(RATE);
        let (cleaned, sys_out) = run(&mut canceller, &mic, &system);
        assert_eq!(cleaned.len(), mic.len());
        assert_eq!(sys_out, system);
    }

    #[test]
    fn holds_back_the_lead_and_returns_it_on_flush() {
        let mut canceller = MicEchoCanceller::new(RATE);
        let held = RATE as usize * (REFERENCE_LEAD_MS + PROCESSING_LATENCY_MS) / 1000;
        let window = vec![0.01f32; 28_800];

        assert_eq!(canceller.process(&window, &window).0.len(), 28_800 - held);
        assert_eq!(canceller.process(&window, &window).0.len(), 28_800);
        let (mic, sys) = canceller.flush();
        assert_eq!(mic.len(), held);
        assert_eq!(sys.len(), held);
    }

    #[test]
    fn sample_counts_balance_across_a_pause() {
        let mut canceller = MicEchoCanceller::new(RATE);
        let mut fed = 0;
        let mut returned = 0;
        for len in [WINDOW, WINDOW, 1_234] {
            let w = vec![0.02f32; len];
            fed += len;
            returned += canceller.process(&w, &w).0.len();
        }
        returned += canceller.flush().0.len();
        assert_eq!(returned, fed);

        for len in [WINDOW, 777] {
            let w = vec![0.02f32; len];
            fed += len;
            returned += canceller.process(&w, &w).0.len();
        }
        returned += canceller.flush().0.len();
        assert_eq!(returned, fed);
    }

    #[test]
    fn flush_with_no_audio_returns_nothing() {
        let mut canceller = MicEchoCanceller::new(RATE);
        assert!(canceller.flush().0.is_empty());
        assert!(canceller.flush().1.is_empty());
    }
}
