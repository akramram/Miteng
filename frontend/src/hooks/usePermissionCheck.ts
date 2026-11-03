import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  getAudioPermissions,
  requestAudioPermissions,
  requestAudioPermissionsAtLaunch,
} from '@/lib/audio-permissions';

export interface PermissionStatus {
  hasMicrophone: boolean;
  hasSystemAudio: boolean;
  isChecking: boolean;
  error: string | null;
}

// The last result in this window, so a page that mounts again (the recorder)
// shows the record card at once while the device check re-runs behind it.
let lastKnown: { hasMicrophone: boolean; hasSystemAudio: boolean } | null = null;

export function usePermissionCheck() {
  const requestInFlight = useRef<Promise<void> | null>(null);
  const [status, setStatus] = useState<PermissionStatus>(() => ({
    hasMicrophone: lastKnown?.hasMicrophone ?? false,
    hasSystemAudio: lastKnown?.hasSystemAudio ?? false,
    isChecking: lastKnown === null,
    error: null,
  }));

  const checkPermissions = async () => {
    // A known result stays on screen during a background re-check.
    if (lastKnown === null) setStatus(prev => ({ ...prev, isChecking: true, error: null }));

    try {
      // Wait for the launch prompts so an unanswered one does not read as denied.
      await requestAudioPermissionsAtLaunch().catch(() => undefined);
      const [devices, access] = await Promise.all([
        invoke<Array<{ name: string; device_type: 'Input' | 'Output' }>>('get_audio_devices'),
        getAudioPermissions(),
      ]);
      const inputDevices = devices.filter(d => d.device_type === 'Input');
      const outputDevices = devices.filter(d => d.device_type === 'Output');
      const hasMicrophone = inputDevices.length > 0 && access.microphone === 'authorized';
      const hasSystemAudio = outputDevices.length > 0 && access.systemAudio === 'authorized';

      console.log('Permission check:', {
        microphone: access.microphone,
        systemAudio: access.systemAudio,
        inputDevices: inputDevices.length,
        outputDevices: outputDevices.length,
      });

      lastKnown = { hasMicrophone, hasSystemAudio };
      setStatus({
        hasMicrophone,
        hasSystemAudio,
        isChecking: false,
        error: null,
      });
    } catch (error) {
      console.error('Failed to check audio permissions:', error);
      setStatus({
        hasMicrophone: false,
        hasSystemAudio: false,
        isChecking: false,
        error: error instanceof Error ? error.message : 'Failed to check permissions',
      });
    }
  };

  const requestPermissions = () => {
    // A prompt can stay open for a while; deduplicate Check again clicks.
    if (requestInFlight.current) return requestInFlight.current;

    const request = (async () => {
      setStatus(prev => ({ ...prev, isChecking: true, error: null }));
      try {
        await requestAudioPermissions();
      } catch (error) {
        console.error('Failed to request permissions:', error);
      }
      await checkPermissions();
      requestInFlight.current = null;
    })();

    requestInFlight.current = request;
    return request;
  };

  // Check permissions on mount
  useEffect(() => {
    checkPermissions();
  }, []);

  return {
    ...status,
    checkPermissions,
    requestPermissions,
  };
}
