//! Microphone activity watch, behind "Start and stop recordings automatically".
//!
//! Separate from meeting detection, which looks for meeting apps by process
//! name and only prompts. This watch asks the OS which other apps are using a
//! microphone right now and emits `mic-activity-started` once an app has held
//! it for a few seconds and `mic-activity-ended` once it has let go for a while.
//! Miteng's own capture is never counted.
//!
//! macOS 14+: Core Audio process objects (`kAudioProcessPropertyIsRunningInput`).
//! Windows: the CapabilityAccessManager consent store. Elsewhere: no events.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};

static GENERATION: AtomicU64 = AtomicU64::new(0);

const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// A mic use shorter than this (dictation, a permission probe) starts nothing.
const START_AFTER: Duration = Duration::from_secs(4);
/// Brief releases (device switch, rejoin) do not end the call.
const END_AFTER: Duration = Duration::from_secs(20);

/// An app using the microphone. `process` identifies it across events.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MicUser {
    pub app: String,
    pub process: String,
}

#[derive(Debug, PartialEq, Eq)]
enum MicEvent {
    Started(MicUser),
    Ended(MicUser),
}

struct Seen {
    user: MicUser,
    since: Instant,
    last: Instant,
    announced: bool,
}

/// Debounces raw "who holds the mic" samples into start and end events.
#[derive(Default)]
struct Tracker {
    seen: HashMap<String, Seen>,
}

impl Tracker {
    fn tick(&mut self, now: Instant, users: Vec<MicUser>) -> Vec<MicEvent> {
        let mut events = Vec::new();
        let mut present: Vec<String> = Vec::with_capacity(users.len());
        for user in users {
            present.push(user.process.clone());
            let entry = self.seen.entry(user.process.clone()).or_insert(Seen { user, since: now, last: now, announced: false });
            entry.last = now;
            if !entry.announced && now.duration_since(entry.since) >= START_AFTER {
                entry.announced = true;
                events.push(MicEvent::Started(entry.user.clone()));
            }
        }
        self.seen.retain(|process, seen| {
            if present.contains(process) {
                return true;
            }
            // Not announced yet: a short blip, forget it so the next use starts the clock again.
            if !seen.announced {
                return false;
            }
            if now.duration_since(seen.last) < END_AFTER {
                return true;
            }
            events.push(MicEvent::Ended(seen.user.clone()));
            false
        });
        events
    }
}

/// The app bundle a process belongs to, from its executable path:
/// `/Applications/Google Chrome.app/…/Google Chrome Helper.app/…` → `Google Chrome`.
#[cfg(any(target_os = "macos", test))]
fn bundle_app_name(exe: &std::path::Path) -> Option<String> {
    exe.components().find_map(|part| part.as_os_str().to_str()?.strip_suffix(".app").map(str::to_string))
}

/// macOS system services that open the mic on their own (Siri, dictation, …).
#[cfg(any(target_os = "macos", test))]
fn is_system_executable(exe: &std::path::Path) -> bool {
    ["/System/Library/", "/usr/", "/Library/Apple/", "/System/iOSSupport/"]
        .iter()
        .any(|prefix| exe.starts_with(prefix))
}

#[cfg(target_os = "macos")]
fn mic_users() -> Vec<MicUser> {
    use cidre::core_audio as ca;

    let own_pid = std::process::id() as i32;
    let Ok(processes) = ca::Process::list() else { return Vec::new() };
    let pids: Vec<sysinfo::Pid> = processes
        .iter()
        .filter(|process| process.is_running_input().unwrap_or(false))
        .filter_map(|process| process.pid().ok())
        .filter(|pid| *pid != own_pid && *pid > 0)
        .map(|pid| sysinfo::Pid::from_u32(pid as u32))
        .collect();
    if pids.is_empty() {
        return Vec::new();
    }

    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&pids), true);
    let mut users: Vec<MicUser> = Vec::new();
    for pid in &pids {
        let Some(process) = system.process(*pid) else { continue };
        let name = process.name().to_string_lossy().to_string();
        let app = match process.exe() {
            Some(exe) if is_system_executable(exe) => continue,
            Some(exe) => bundle_app_name(exe).unwrap_or_else(|| name.clone()),
            None => name.clone(),
        };
        if crate::meeting_detection::is_self_process(&app) || crate::meeting_detection::is_self_process(&name) {
            continue;
        }
        // Helpers of one app (browser tabs, WebView) count as that app.
        if !users.iter().any(|user| user.process == app) {
            users.push(MicUser { process: app.clone(), app });
        }
    }
    users
}

#[cfg(windows)]
fn mic_users() -> Vec<MicUser> {
    let mut users: Vec<MicUser> = Vec::new();
    for exe in crate::meeting_detection::windows_media_in_use_exes(&["microphone"]) {
        if crate::meeting_detection::is_self_process(&exe) {
            continue;
        }
        let stem = exe.trim_end_matches(".exe");
        let mut app = stem.to_string();
        if let Some(first) = app.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        users.push(MicUser { app, process: exe });
    }
    users
}

#[cfg(not(any(target_os = "macos", windows)))]
fn mic_users() -> Vec<MicUser> {
    Vec::new()
}

fn start<R: Runtime>(app: AppHandle<R>) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        log::info!("Microphone activity watch started");
        let mut tracker = Tracker::default();
        while GENERATION.load(Ordering::SeqCst) == generation {
            let users = tokio::task::spawn_blocking(mic_users).await.unwrap_or_default();
            if GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            for event in tracker.tick(Instant::now(), users) {
                match event {
                    MicEvent::Started(user) => {
                        log::info!("Microphone in use by {}", user.app);
                        let _ = app.emit("mic-activity-started", user);
                    }
                    MicEvent::Ended(user) => {
                        log::info!("Microphone released by {}", user.app);
                        let _ = app.emit("mic-activity-ended", user);
                    }
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
        log::info!("Microphone activity watch stopped");
    });
}

/// Turns the watch on or off. The switch itself is a Labs preference kept by the frontend.
#[tauri::command]
pub async fn set_mic_activity_watch<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<(), String> {
    if enabled {
        start(app);
    } else {
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn user(name: &str) -> MicUser {
        MicUser { app: name.to_string(), process: name.to_string() }
    }

    #[test]
    fn starts_after_a_steady_hold_and_ends_after_a_long_release() {
        let t0 = Instant::now();
        let at = |secs: u64| t0 + Duration::from_secs(secs);
        let mut tracker = Tracker::default();

        assert!(tracker.tick(at(0), vec![user("Teams")]).is_empty());
        assert!(tracker.tick(at(2), vec![user("Teams")]).is_empty());
        assert_eq!(tracker.tick(at(4), vec![user("Teams")]), vec![MicEvent::Started(user("Teams"))]);
        assert!(tracker.tick(at(6), vec![user("Teams")]).is_empty(), "announced once");

        // A short release keeps the call going.
        assert!(tracker.tick(at(10), vec![]).is_empty());
        assert!(tracker.tick(at(12), vec![user("Teams")]).is_empty());
        assert!(tracker.tick(at(31), vec![]).is_empty());
        assert_eq!(tracker.tick(at(32), vec![]), vec![MicEvent::Ended(user("Teams"))]);
    }

    #[test]
    fn short_blips_never_start_and_restart_the_clock() {
        let t0 = Instant::now();
        let at = |secs: u64| t0 + Duration::from_secs(secs);
        let mut tracker = Tracker::default();

        assert!(tracker.tick(at(0), vec![user("Notes")]).is_empty());
        assert!(tracker.tick(at(2), vec![]).is_empty());
        assert!(tracker.tick(at(4), vec![user("Notes")]).is_empty(), "the clock restarted at 4 s");
        assert!(tracker.tick(at(6), vec![user("Notes")]).is_empty());
        assert_eq!(tracker.tick(at(8), vec![user("Notes")]), vec![MicEvent::Started(user("Notes"))]);
    }

    #[test]
    fn helpers_map_to_their_app_and_system_services_are_skipped() {
        let chrome = Path::new(
            "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
        );
        assert_eq!(bundle_app_name(chrome).as_deref(), Some("Google Chrome"));
        assert_eq!(bundle_app_name(Path::new("/opt/homebrew/bin/sox")), None);
        assert!(is_system_executable(Path::new("/System/Library/PrivateFrameworks/CoreSpeech.framework/corespeechd")));
        assert!(!is_system_executable(Path::new("/System/Applications/FaceTime.app/Contents/MacOS/FaceTime")));
        assert!(!is_system_executable(chrome));
    }
}
