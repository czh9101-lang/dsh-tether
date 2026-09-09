// 命令只由 Rust 侧经 run_mobile_plugin 调用,不暴露给 JS;这里登记只是让
// tauri-plugin 把 android/ 工程接进 App 的 gradle。
const COMMANDS: &[&str] = &["start_service", "stop_service"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
