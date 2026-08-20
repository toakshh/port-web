/// Close the application from the web layer.
///
/// The wrapped web build is a pre-compiled bundle, so it cannot import the
/// Tauri JS packages. `app.withGlobalTauri` exposes `window.__TAURI__` instead,
/// which makes this command callable as:
///
/// ```js
/// await window.__TAURI__.core.invoke('exit_app')        // exit code 0
/// await window.__TAURI__.core.invoke('exit_app', { code: 1 })
/// ```
#[tauri::command]
fn exit_app(app: tauri::AppHandle, code: Option<i32>) {
  let code = code.unwrap_or(0);

  // Android has no concept of an app "exiting" the way a desktop app does, and
  // AppHandle::exit can leave the activity alive. Ending the process is what
  // actually closes the app there.
  #[cfg(target_os = "android")]
  {
    let _ = app;
    std::process::exit(code);
  }

  // Desktop: ask Tauri to shut down cleanly so window/teardown events still run.
  // AppHandle::exit does not reliably carry the status code through, so the
  // process is ended explicitly once cleanup has been requested.
  #[cfg(not(target_os = "android"))]
  {
    app.cleanup_before_exit();
    std::process::exit(code);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![exit_app])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
