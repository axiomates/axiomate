extern crate napi_build;

fn main() {
    napi_build::setup();
    // The `windows` crate handles MSVC-side framework / lib linking
    // automatically per the features enabled in Cargo.toml. Nothing
    // platform-specific to do here beyond napi_build::setup().
}
