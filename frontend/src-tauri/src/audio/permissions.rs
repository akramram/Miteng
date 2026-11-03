// macOS audio permissions handling.
//
// The `screen_recording` names are legacy IPC/API names. Current macOS capture
// uses Audio Capture permission and a Core Audio process tap, not screen video.
// `check_screen_recording_permission` reports platform support only; the audible
// up-to-five-second probe below is the actual runtime verification.
use anyhow::Result;
use log::{info, warn, error};

#[cfg(target_os = "macos")]
use std::process::Command;

/// Check whether the platform supports the Audio Capture permission flow.
///
/// Note: Core Audio taps require NSAudioCaptureUsageDescription in Info.plist.
/// When the app first attempts to create a Core Audio tap, macOS will automatically
/// show a permission dialog to the user. If permission is denied, the tap will return
/// silence (all zeros).
///
/// This function returns true because the actual permission prompt happens automatically
/// when AudioHardwareCreateProcessTap is called by the cidre library.
#[cfg(target_os = "macos")]
pub fn check_screen_recording_permission() -> bool {
    info!("ℹ️  Core Audio tap requires Audio Capture permission (macOS 14.2+)");
    info!("📍 Permission dialog will appear automatically when recording starts");
    info!("   If already granted: System Settings → Privacy & Security → Audio Capture");

    // Always return true - the actual permission dialog is triggered by Core Audio API
    true
}

#[cfg(not(target_os = "macos"))]
pub fn check_screen_recording_permission() -> bool {
    true // Not required on other platforms
}

/// Request Audio Capture permission from the user
/// This will open System Settings to the Privacy & Security page
#[cfg(target_os = "macos")]
pub fn request_screen_recording_permission() -> Result<()> {
    info!("🔐 Opening System Settings for Audio Capture permission...");

    // Open System Settings to Privacy & Security page
    // Note: There's no direct URL for Audio Capture, so we open the main Privacy page
    let result = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security")
        .spawn();

    match result {
        Ok(_) => {
            info!("✅ Opened System Settings - navigate to Privacy & Security → Audio Capture");
            info!("👉 Please enable Audio Capture permission and restart the app");
            Ok(())
        }
        Err(e) => {
            error!("❌ Failed to open System Settings: {}", e);
            Err(anyhow::anyhow!("Failed to open System Settings: {}", e))
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_recording_permission() -> Result<()> {
    Ok(()) // Not required on other platforms
}

/// Check and request Audio Capture permission if not granted
/// Returns true if permission is granted, false otherwise
pub fn ensure_screen_recording_permission() -> bool {
    if check_screen_recording_permission() {
        return true;
    }

    warn!("Audio Capture permission not granted - requesting...");

    if let Err(e) = request_screen_recording_permission() {
        error!("Failed to request Audio Capture permission: {}", e);
        return false;
    }

    false // Permission will be granted after restart
}

/// Tauri command to check Screen Recording permission
#[tauri::command]
pub async fn check_screen_recording_permission_command() -> bool {
    check_screen_recording_permission()
}

/// Tauri command to request Screen Recording permission
#[tauri::command]
pub async fn request_screen_recording_permission_command() -> Result<(), String> {
    request_screen_recording_permission()
        .map_err(|e| e.to_string())
}

/// Trigger the system-audio permission request and probe functional capture.
/// Returns Ok(true) only when the started tap receives audible system audio;
/// false can mean denial, silence, or another capture initialization failure.
#[cfg(target_os = "macos")]
pub fn trigger_system_audio_permission() -> Result<bool> {
    info!("🔐 Triggering Audio Capture permission request...");

    match crate::audio::capture::CoreAudioCapture::new() {
        Ok(capture) => {
            info!("✅ Core Audio tap created; starting native capture probe");
            let detected = capture.probe(std::time::Duration::from_secs(5))?;
            if detected {
                info!("✅ Native system audio capture verified");
            } else {
                warn!(
                    "Audio Capture returned silence; permission may be denied or no audio was playing"
                );
            }
            Ok(detected)
        }
        Err(e) => {
            let error_msg = e.to_string().to_lowercase();
            if error_msg.contains("permission") || error_msg.contains("denied") {
                info!("🔐 Audio Capture permission denied");
                info!("👉 Please grant Audio Capture permission in System Settings");
                return Ok(false);
            }
            warn!("⚠️ Failed to create Core Audio tap: {}", e);
            // If tap creation fails for other reasons, still return false
            // as we can't verify permission status
            Ok(false)
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn trigger_system_audio_permission() -> Result<bool> {
    // System audio permissions not required on other platforms
    info!("System audio permissions not required on this platform");
    Ok(true)
}

/// Trigger Audio Capture permission and test for audible samples for up to five
/// seconds. False is not a definitive denial status because silence is identical.
#[tauri::command]
pub async fn trigger_system_audio_permission_command() -> Result<bool, String> {
    // Run in blocking task to avoid blocking the async runtime
    tokio::task::spawn_blocking(|| {
        trigger_system_audio_permission()
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| e.to_string())
}

/// The user's answer to a macOS privacy prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Authorized,
    Denied,
    NotDetermined,
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAccess {
    pub microphone: Access,
    pub system_audio: Access,
}

/// Microphone and Audio Capture access as macOS records it, without prompting.
#[tauri::command]
pub async fn get_audio_permissions() -> AudioAccess {
    AudioAccess {
        microphone: access::microphone(),
        system_audio: access::audio_capture(),
    }
}

/// Shows the microphone and Audio Capture prompts the user has not answered
/// yet, one after the other. Answered ones return at once without a prompt.
#[tauri::command]
pub async fn request_audio_permissions() -> AudioAccess {
    // Each request waits for the user's answer, so keep it off the async runtime.
    let access = tokio::task::spawn_blocking(|| AudioAccess {
        microphone: access::request_microphone(),
        system_audio: access::request_audio_capture(),
    })
    .await
    .unwrap_or_else(|_| AudioAccess {
        microphone: access::microphone(),
        system_audio: access::audio_capture(),
    });
    info!(
        "Audio permissions: microphone {:?}, Audio Capture {:?}",
        access.microphone, access.system_audio
    );
    access
}

#[cfg(not(target_os = "macos"))]
mod access {
    use super::Access;

    pub fn microphone() -> Access {
        Access::Authorized
    }

    pub fn audio_capture() -> Access {
        Access::Authorized
    }

    pub fn request_microphone() -> Access {
        Access::Authorized
    }

    pub fn request_audio_capture() -> Access {
        Access::Authorized
    }
}

#[cfg(target_os = "macos")]
mod access {
    use super::Access;
    use cidre::{av, blocks, cf};
    use log::warn;
    use std::ffi::{c_char, c_int, c_void};
    use std::sync::{mpsc, LazyLock};

    pub fn microphone() -> Access {
        match av::CaptureDevice::authorization_status_for_media_type(av::MediaType::audio()) {
            Ok(av::AuthorizationStatus::Authorized) => Access::Authorized,
            Ok(av::AuthorizationStatus::Denied | av::AuthorizationStatus::Restricted) => Access::Denied,
            Ok(av::AuthorizationStatus::NotDetermined) => Access::NotDetermined,
            Err(e) => {
                warn!("Microphone authorization status unavailable: {e:?}");
                Access::NotDetermined
            }
        }
    }

    pub fn request_microphone() -> Access {
        let status = microphone();
        if status != Access::NotDetermined {
            return status;
        }
        let answer = wait_for_answer(|block| {
            if let Err(e) = av::CaptureDevice::request_access_for_media_type_ch(av::MediaType::audio(), block) {
                warn!("Microphone access request failed: {e:?}");
            }
        });
        answer.map_or_else(microphone, granted)
    }

    fn granted(yes: bool) -> Access {
        if yes {
            Access::Authorized
        } else {
            Access::Denied
        }
    }

    /// Runs a request that answers through a completion block and waits for it.
    /// None when the request dropped the block without answering.
    fn wait_for_answer(ask: impl FnOnce(&mut blocks::SendBlock<fn(bool)>)) -> Option<bool> {
        let (tx, rx) = mpsc::channel();
        let mut block = blocks::SendBlock::new1(move |yes: bool| {
            let _ = tx.send(yes);
        });
        ask(&mut block);
        drop(block);
        rx.recv().ok()
    }

    // Audio Capture has no public status API; the TCC calls below are the
    // ones System Settings itself reads. They answer for this app bundle.
    const SERVICE: &str = "kTCCServiceAudioCapture";
    const RTLD_NOW: c_int = 2;

    extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    type Preflight = unsafe extern "C" fn(&cf::String, Option<&cf::Dictionary>) -> c_int;
    type Request =
        unsafe extern "C" fn(&cf::String, Option<&cf::Dictionary>, &blocks::SendBlock<fn(bool)>);

    struct Tcc {
        preflight: Preflight,
        request: Request,
    }

    static TCC: LazyLock<Option<Tcc>> = LazyLock::new(|| unsafe {
        let handle = dlopen(
            c"/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC".as_ptr(),
            RTLD_NOW,
        );
        let symbol = |name: &std::ffi::CStr| if handle.is_null() { handle } else { dlsym(handle, name.as_ptr()) };
        let (preflight, request) = (symbol(c"TCCAccessPreflight"), symbol(c"TCCAccessRequest"));
        if preflight.is_null() || request.is_null() {
            warn!("TCC is unavailable; Audio Capture access cannot be read");
            return None;
        }
        Some(Tcc {
            preflight: std::mem::transmute::<*mut c_void, Preflight>(preflight),
            request: std::mem::transmute::<*mut c_void, Request>(request),
        })
    });

    pub fn audio_capture() -> Access {
        let Some(tcc) = TCC.as_ref() else { return Access::NotDetermined };
        let service = cf::String::from_str(SERVICE);
        match unsafe { (tcc.preflight)(&service, None) } {
            0 => Access::Authorized,
            1 => Access::Denied,
            _ => Access::NotDetermined,
        }
    }

    pub fn request_audio_capture() -> Access {
        let status = audio_capture();
        let Some(tcc) = TCC.as_ref().filter(|_| status == Access::NotDetermined) else { return status };
        let service = cf::String::from_str(SERVICE);
        let answer = wait_for_answer(|block| unsafe { (tcc.request)(&service, None, block) });
        answer.map_or_else(audio_capture, granted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_permission() {
        let has_permission = check_screen_recording_permission();
        println!("Has Screen Recording permission: {}", has_permission);
    }
}
