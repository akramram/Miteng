/**
 * Turning Labs features on and off. Four of them keep their real state in
 * Rust (Whisper silence guard, voice profiles, Parakeet on the GPU, echo
 * cancellation); the browser copy in lib/labs mirrors them so any page can
 * read them at once.
 */
import { invoke } from '@tauri-apps/api/core';
import { loadLabsPreferences, saveLabsPreferences, type LabsPreferences } from '@/lib/labs';

export type LabsFeature = keyof LabsPreferences;

/** Refreshes the mirrored switches from Rust. */
export async function syncLabsFromBackend(): Promise<LabsPreferences> {
  const [whisper, voices, gpu, echo] = await Promise.allSettled([
    invoke<boolean>('get_whisper_strict_silence'),
    invoke<boolean>('get_voice_profiles_enabled'),
    invoke<boolean>('get_parakeet_gpu_enabled'),
    invoke<boolean>('get_echo_cancellation_enabled'),
  ]);
  const current = loadLabsPreferences();
  const next: LabsPreferences = {
    ...current,
    whisperSilenceGuard: whisper.status === 'fulfilled' ? whisper.value : current.whisperSilenceGuard,
    voiceProfiles: voices.status === 'fulfilled' ? voices.value : current.voiceProfiles,
    parakeetGpu: gpu.status === 'fulfilled' ? gpu.value : current.parakeetGpu,
    echoCancellation: echo.status === 'fulfilled' ? echo.value : current.echoCancellation,
  };
  if (JSON.stringify(next) !== JSON.stringify(current)) saveLabsPreferences(next);
  return next;
}

/**
 * Saves one switch, applying its backend side first. Rejects with the reason
 * when the backend refuses, and then nothing is saved.
 */
export async function setLabsFeature(feature: LabsFeature, value: boolean): Promise<LabsPreferences> {
  switch (feature) {
    case 'whisperSilenceGuard':
      await invoke('set_whisper_strict_silence', { enabled: value });
      break;
    case 'voiceProfiles':
      await invoke('set_voice_profiles_enabled', { value });
      break;
    case 'parakeetGpu':
      // Reloads the current Parakeet model; Rust restores CPU if that fails.
      await invoke('set_parakeet_gpu_enabled', { value });
      break;
    case 'echoCancellation':
      await invoke('set_echo_cancellation_enabled', { enabled: value });
      break;
    default:
      break;
  }
  const next = { ...loadLabsPreferences(), [feature]: value };
  saveLabsPreferences(next);
  return next;
}
