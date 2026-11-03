import { invoke } from '@tauri-apps/api/core';

export type AudioAccess = 'authorized' | 'denied' | 'not_determined';

export interface AudioPermissions {
  microphone: AudioAccess;
  systemAudio: AudioAccess;
}

/** Reads microphone and Audio Capture access from macOS without prompting. */
export const getAudioPermissions = () => invoke<AudioPermissions>('get_audio_permissions');

/** Prompts for whichever of the two the user has not answered yet. */
export const requestAudioPermissions = () => invoke<AudioPermissions>('request_audio_permissions');

let launchRequest: Promise<AudioPermissions> | null = null;

/**
 * The launch-time request, shared by everything that waits for it: the
 * prompts appear once per window load and checks run after they are answered.
 */
export function requestAudioPermissionsAtLaunch(): Promise<AudioPermissions> {
  launchRequest ??= requestAudioPermissions().catch((error) => {
    launchRequest = null;
    throw error;
  });
  return launchRequest;
}
