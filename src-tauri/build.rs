fn main() {
  // The Windows executable icon is embedded by tauri-build's build script, but
  // tauri-build only declares the config, capabilities and frontend dist as
  // rerun triggers - never the icon file. Every build writes the generated icon
  // to the same path, so a *different* icon has an unchanged path and Cargo
  // reuses the cached build-script output, leaving the previous icon baked into
  // the binary. Only a clean build (empty cache) picked up a new icon.
  //
  // build.js sets TRIPO_ICON_HASH to a digest of the generated icon, so a new
  // icon changes the value and forces this script - and the icon embedding -
  // to run again.
  println!("cargo:rerun-if-env-changed=TRIPO_ICON_HASH");
  tauri_build::build()
}
