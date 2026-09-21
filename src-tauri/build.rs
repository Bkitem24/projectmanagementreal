fn main() {
    // Windows-only: embeds windows-app-manifest.xml into the built .exe so
    // it always requests "Run as administrator" (UAC elevation) - see that
    // file's comment for why. This is a real Windows application manifest,
    // not a Tauri-specific setting, which is why it's wired up through
    // tauri-build's WindowsAttributes rather than tauri.conf.json - Tauri
    // has no first-class "requireAdministrator" config key, this embedded
    // manifest IS the actual mechanism Windows itself reads at launch.
    //
    // Gated to Windows so a future macOS build (asked about 2026-09-21,
    // planned for later - see phase-3-punch-list.md) isn't affected at all;
    // this manifest means nothing outside Windows.
    #[cfg(target_os = "windows")]
    {
        let windows = tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("windows-app-manifest.xml"));
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to run tauri-build with the Windows admin-elevation manifest");
    }
    #[cfg(not(target_os = "windows"))]
    {
        tauri_build::build();
    }
}
