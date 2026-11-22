fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        // 声明**全部** app 命令，让 tauri-build 为每条生成 allow-/deny- 权限。
        //
        // 踩过的坑：app_manifest 一旦启用，就只在声明范围内生成权限；
        // 漏掉的命令等于「任何窗口都调不了」。所以这里必须与
        // main.rs 的 generate_handler! 列表逐条对齐——新增命令时两处都要改。
        //
        // 哪些命令对远程页面开放，由 capabilities/ 决定：
        //   - capabilities/default.json      → 仅本地窗口（overlay/settings）
        //   - capabilities/lyrics-bridge.json → 仅 main + 站点 origin，只有 lyrics_* 两条
        tauri_build::AppManifest::new().commands(&[
            // 本地窗口专用
            "public_device_config",
            "connection_config",
            "pair_device",
            "clear_pairing",
            "set_overlay_visible",
            "start_overlay_drag",
            "get_click_through",
            "overlay_position",
            "set_overlay_position",
            // 歌词用户设置（本地窗口：歌词窗与设置页）
            "lyrics_settings_get",
            "lyrics_settings_update",
            "lyrics_reset_position",
            "lyrics_save_position",
            // 歌词壳内直连（唯一对远程页面开放的窄权限）
            "lyrics_push_state",
            "lyrics_send_command",
        ]),
    ))
    .expect("failed to run tauri-build");
}
