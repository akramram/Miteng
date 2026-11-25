//! Audio of one browser tab, sent by the Miteng tab audio extension
//! (`resources/browser-extension`) over a WebSocket on 127.0.0.1.
//!
//! Every tab of Edge or Chrome plays through the same audio process, so a
//! process tap cannot single out a Meet or Teams tab. The extension captures
//! the tab with `chrome.tabCapture`, like "share tab audio" does, and streams it
//! here. Only the extension's origin may connect; its ID is fixed by the `key`
//! in its manifest.
//!
//! Protocol: the extension sends a JSON text `hello` {sampleRate, title, url}
//! and gets `{"type":"ready"}`; then binary frames of little-endian f32 mono
//! samples at 48 kHz. The most recent tab wins: an older connection is told
//! `{"type":"stop"}` and closed.

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

pub const PORT: u16 = 47920;
pub const SAMPLE_RATE: u32 = 48_000;
/// Derived from the public key in the extension's manifest.
pub const EXTENSION_ID: &str = "cfhjngnhafghohbjemmfaddmbbpcdeep";
pub const STATUS_EVENT: &str = "browser-tab-status";

/// Blocks of 20 ms; a few seconds absorb a busy pipeline.
const SINK_BLOCKS: usize = 256;
const HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct BrowserTabStatus {
    /// Miteng is listening for the extension.
    pub listening: bool,
    /// A tab is sending audio.
    pub connected: bool,
    pub title: Option<String>,
    pub url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    #[serde(rename = "type")]
    kind: String,
    sample_rate: u32,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
}

#[derive(Default)]
struct HubState {
    status: BrowserTabStatus,
    /// Connection whose audio is used; older ones are told to stop.
    active: u64,
    next_id: u64,
    sink: Option<mpsc::Sender<Vec<f32>>>,
    dropped_blocks: u64,
}

type StatusListener = Box<dyn Fn(&BrowserTabStatus) + Send + Sync>;

/// Connection state shared by the server and the recording that reads the tab.
#[derive(Default)]
pub struct Hub {
    state: Mutex<HubState>,
    listener: Mutex<Option<StatusListener>>,
}

impl Hub {
    pub fn status(&self) -> BrowserTabStatus {
        self.state.lock().unwrap().status.clone()
    }

    pub fn set_status_listener(&self, listener: impl Fn(&BrowserTabStatus) + Send + Sync + 'static) {
        *self.listener.lock().unwrap() = Some(Box::new(listener));
    }

    fn update_status(&self, change: impl FnOnce(&mut BrowserTabStatus)) {
        let status = {
            let mut state = self.state.lock().unwrap();
            change(&mut state.status);
            state.status.clone()
        };
        if let Some(listener) = self.listener.lock().unwrap().as_ref() {
            listener(&status);
        }
    }

    /// Audio from the connected tab, until `unsubscribe` or another `subscribe`.
    pub fn subscribe(&self) -> mpsc::Receiver<Vec<f32>> {
        let (sender, receiver) = mpsc::channel(SINK_BLOCKS);
        let mut state = self.state.lock().unwrap();
        state.sink = Some(sender);
        state.dropped_blocks = 0;
        receiver
    }

    pub fn unsubscribe(&self) {
        self.state.lock().unwrap().sink = None;
    }

    fn activate(&self, hello: &Hello) -> u64 {
        let id = {
            let mut state = self.state.lock().unwrap();
            state.next_id += 1;
            state.active = state.next_id;
            state.active
        };
        self.update_status(|status| {
            status.connected = true;
            status.title = Some(hello.title.clone()).filter(|t| !t.is_empty());
            status.url = Some(hello.url.clone()).filter(|u| !u.is_empty());
        });
        id
    }

    fn is_active(&self, id: u64) -> bool {
        self.state.lock().unwrap().active == id
    }

    fn deactivate(&self, id: u64) {
        {
            let mut state = self.state.lock().unwrap();
            if state.active != id {
                return;
            }
            state.active = 0;
        }
        self.update_status(|status| {
            status.connected = false;
            status.title = None;
            status.url = None;
        });
    }

    fn deliver(&self, samples: Vec<f32>) {
        let mut state = self.state.lock().unwrap();
        let Some(sink) = state.sink.as_ref() else { return };
        if sink.try_send(samples).is_err() {
            state.dropped_blocks += 1;
            if state.dropped_blocks == 1 || state.dropped_blocks % 500 == 0 {
                warn!("Browser tab audio: recording fell behind, dropped {} blocks", state.dropped_blocks);
            }
        }
    }
}

pub static HUB: once_cell::sync::Lazy<Arc<Hub>> = once_cell::sync::Lazy::new(|| Arc::new(Hub::default()));

fn origin_allowed(origin: Option<&str>) -> bool {
    origin.and_then(|o| o.strip_prefix("chrome-extension://")) == Some(EXTENSION_ID)
}

/// Accepts extension connections until the listener fails.
pub async fn serve(listener: TcpListener, hub: Arc<Hub>) {
    hub.update_status(|status| status.listening = true);
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(handle_connection(stream, hub.clone()));
            }
            Err(error) => warn!("Browser tab audio: accept failed: {error}"),
        }
    }
}

/// Starts the server on 127.0.0.1:`PORT` and reports status changes to the UI.
pub fn start<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    use tauri::Emitter;
    // Keep an already loaded extension in step with this version of Miteng.
    if extension_folder().exists() {
        if let Err(error) = install_extension_folder(&app) {
            warn!("Browser tab audio: could not update the extension folder: {error}");
        }
    }
    HUB.set_status_listener(move |status| {
        let _ = app.emit(STATUS_EVENT, status);
    });
    tauri::async_runtime::spawn(async {
        match TcpListener::bind(("127.0.0.1", PORT)).await {
            Ok(listener) => {
                info!("Browser tab audio: listening on 127.0.0.1:{PORT}");
                serve(listener, HUB.clone()).await;
            }
            Err(error) => warn!("Browser tab audio unavailable: cannot listen on 127.0.0.1:{PORT}: {error}"),
        }
    });
}

#[tauri::command]
pub fn get_browser_tab_status() -> BrowserTabStatus {
    HUB.status()
}

/// Puts the extension in the data folder, shows it in Finder, and returns its path
/// for Edge's "Load unpacked".
#[tauri::command]
pub fn open_browser_extension_folder<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<String, String> {
    let folder = install_extension_folder(&app).map_err(|e| format!("Could not prepare the extension: {e}"))?;
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let opener = "xdg-open";
    std::process::Command::new(opener)
        .arg(&folder)
        .spawn()
        .map_err(|e| format!("Could not open the folder: {e}"))?;
    Ok(folder.to_string_lossy().into_owned())
}

fn extension_folder() -> std::path::PathBuf {
    crate::paths::install_data_root().join("browser-extension")
}

async fn handle_connection(stream: TcpStream, hub: Arc<Hub>) {
    let check_origin = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let origin = request.headers().get("origin").and_then(|value| value.to_str().ok());
        if request.uri().path() == "/tab" && origin_allowed(origin) {
            return Ok(response);
        }
        warn!("Browser tab audio: refused connection from origin {:?} to {}", origin, request.uri().path());
        let mut refusal = ErrorResponse::new(None);
        *refusal.status_mut() = StatusCode::FORBIDDEN;
        Err(refusal)
    };
    let Ok(socket) = tokio_tungstenite::accept_hdr_async(stream, check_origin).await else { return };
    let (mut outgoing, mut incoming) = socket.split();

    let hello = match tokio::time::timeout(HELLO_TIMEOUT, incoming.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Hello>(&text).ok(),
        _ => None,
    };
    let Some(hello) = hello.filter(|h| h.kind == "hello") else {
        warn!("Browser tab audio: connection sent no valid hello");
        return;
    };
    if hello.sample_rate != SAMPLE_RATE {
        warn!("Browser tab audio: refused {} Hz audio, expected {SAMPLE_RATE}", hello.sample_rate);
        let _ = outgoing.send(Message::Close(None)).await;
        return;
    }

    let id = hub.activate(&hello);
    info!("Browser tab audio: tab connected ({})", hello.url);
    if outgoing.send(Message::Text(r#"{"type":"ready"}"#.into())).await.is_ok() {
        while let Some(message) = incoming.next().await {
            match message {
                Ok(Message::Binary(bytes)) => {
                    if !hub.is_active(id) {
                        let _ = outgoing.send(Message::Text(r#"{"type":"stop"}"#.into())).await;
                        let _ = outgoing.send(Message::Close(None)).await;
                        break;
                    }
                    let samples = bytes
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                        .collect();
                    hub.deliver(samples);
                }
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
    }
    hub.deactivate(id);
    info!("Browser tab audio: tab disconnected");
}

/// Copies the bundled extension to the data folder, so Edge loads it from a
/// path that survives app updates and is never inside a mounted DMG.
fn install_extension_folder<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> anyhow::Result<std::path::PathBuf> {
    use tauri::Manager;
    let source = app.path().resource_dir()?.join("resources").join("browser-extension");
    let target = extension_folder();
    copy_dir(&source, &target)?;
    Ok(target)
}

fn copy_dir(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let destination = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &destination)?;
        } else {
            std::fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    async fn server() -> (Arc<Hub>, String) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("ws://{}/tab", listener.local_addr().unwrap());
        let hub = Arc::new(Hub::default());
        tokio::spawn(serve(listener, hub.clone()));
        (hub, url)
    }

    async fn connect(
        url: &str,
        origin: &str,
    ) -> Result<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        tokio_tungstenite::tungstenite::Error,
    > {
        let mut request = url.into_client_request().unwrap();
        request.headers_mut().insert("origin", origin.parse().unwrap());
        tokio_tungstenite::connect_async(request).await.map(|(socket, _)| socket)
    }

    fn frame(value: f32, count: usize) -> Message {
        Message::Binary(std::iter::repeat(value.to_le_bytes()).take(count).flatten().collect())
    }

    async fn say_hello(socket: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>, title: &str) {
        let hello = format!(r#"{{"type":"hello","sampleRate":48000,"title":"{title}","url":"https://meet.google.com/x"}}"#);
        socket.send(Message::Text(hello)).await.unwrap();
        assert_eq!(socket.next().await.unwrap().unwrap(), Message::Text(r#"{"type":"ready"}"#.into()));
    }

    #[tokio::test]
    async fn only_the_extension_may_connect() {
        let (_hub, url) = server().await;
        assert!(connect(&url, "https://evil.example").await.is_err());
        assert!(connect(&url, "chrome-extension://abcdefghijklmnopabcdefghijklmnop").await.is_err());
        assert!(connect(&url, &format!("chrome-extension://{EXTENSION_ID}")).await.is_ok());
    }

    #[tokio::test]
    async fn the_newest_tab_feeds_the_recording_and_the_older_one_is_stopped() {
        let (hub, url) = server().await;
        let origin = format!("chrome-extension://{EXTENSION_ID}");
        let mut audio = hub.subscribe();

        let mut first = connect(&url, &origin).await.unwrap();
        say_hello(&mut first, "Meet").await;
        first.send(frame(0.25, 960)).await.unwrap();
        let block = audio.recv().await.unwrap();
        assert_eq!(block.len(), 960);
        assert!(block.iter().all(|&s| s == 0.25));
        assert_eq!(hub.status().title.as_deref(), Some("Meet"));

        let mut second = connect(&url, &origin).await.unwrap();
        say_hello(&mut second, "Teams").await;
        first.send(frame(0.5, 960)).await.unwrap();
        assert_eq!(first.next().await.unwrap().unwrap(), Message::Text(r#"{"type":"stop"}"#.into()));
        second.send(frame(0.75, 960)).await.unwrap();
        assert!(audio.recv().await.unwrap().iter().all(|&s| s == 0.75));
        assert_eq!(hub.status().title.as_deref(), Some("Teams"));

        // The stopped first tab must not mark the second one as gone.
        drop(first);
        second.send(frame(0.75, 960)).await.unwrap();
        audio.recv().await.unwrap();
        assert!(hub.status().connected);

        second.close(None).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while hub.status().connected {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
