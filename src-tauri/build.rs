fn main() {
    // screencapturekit's Swift bridge links against the Swift concurrency
    // runtime via a relative @rpath reference. A linker flag set inside a
    // dependency's own build.rs doesn't carry through to our final binary —
    // only one set here does. Without this, the app crashes at launch in a
    // bundled build with "Library not loaded: @rpath/libswift_Concurrency.dylib"
    // even though it runs fine under `tauri dev`.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }

    tauri_build::build()
}