fn main() {
    tauri_build::build();

    // Link the system gtk-layer-shell library on Linux for Wayland-native
    // window positioning (wlr-layer-shell protocol). Silently skipped on
    // non-Linux targets or if the library isn't found — the layer_shell
    // module is cfg(target_os = "linux") only.
    #[cfg(target_os = "linux")]
    {
        match pkg_config::probe_library("gtk-layer-shell-0") {
            Ok(_) => {}
            Err(e) => {
                // gtk-layer-shell is optional at build time; the commands
                // will fail at runtime if the library isn't present.
                println!("cargo:warning=gtk-layer-shell not found: {e}");
                println!("cargo:warning=Layer-shell orbit positioning will be disabled.");
            }
        }
    }
}