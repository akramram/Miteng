#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    app_lib::logging::init();
    log::info!("Starting application...");
    app_lib::run();
}
