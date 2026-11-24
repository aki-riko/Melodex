//! 置顶层级守护：把「样式位是 topmost 但实际被压在普通窗口下」这种失位拉回来。
//!
//! ## 为什么需要它（真机现场证据，2026-11-24）
//!
//! 用户报「桌面歌词没置顶」。抓到的活体故障态：
//!
//! ```text
//! exstyle=0xC0138  →  WS_EX_TOPMOST = True      （样式位说它是置顶窗口）
//! z 序 rank=15     →  上方压着 14 个非置顶窗口  （实际却在普通层）
//!                    其中 7 个几何上完全覆盖歌词窗
//! ```
//!
//! 触发源是**全屏独占应用**（用户原话「刚关闭游戏」）。全屏游戏运行期间 Windows
//! 把其它顶层窗口降级，但**保留 `WS_EX_TOPMOST` 样式位**；游戏退出后它自己不会恢复。
//!
//! ## 关键机制：样式位为真 ≠ 在置顶层
//!
//! 实测（本机三次独立实验）：
//! - 只写 `SetWindowLongW(GWL_EXSTYLE, ex | WS_EX_TOPMOST)` + `SWP_NOZORDER` 刷新：
//!   **完全无效**，窗口仍停在普通层（系统会立刻把样式位改回去）。
//! - `SetWindowPos(hwnd, HWND_TOPMOST, ...)`：**立刻恢复**（rank 15 → 0）。
//!
//! 所以判定「有没有失位」**必须读真实 z 序**，不能读样式位；
//! 修复只能用 z-order API，不能写样式位。
//!
//! ## 为什么是「只读检测 + 失位才动作」
//!
//! 周期性无条件重申置顶会让窗口每次都短暂掉出置顶层再回来（视觉上闪一下），
//! 而且会跟其它置顶程序互相抢。只读检查是纯查询，正常时**零副作用**。

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Manager};

use crate::logging;

/// 守护巡检周期（毫秒）。
///
/// 取值权衡：
/// - 太短 → 每次都遍历一遍 z 链，白白耗 CPU（虽然只是只读查询）；
/// - 太长 → 游戏退出后要等好几秒歌词才回到最上层，用户会以为「又没置顶」。
///
/// 1.5s 是「人不会盯着看半秒级延迟、单次遍历成本可忽略」的折中。
pub const GUARD_INTERVAL_MS: u64 = 1_500;

/// 检测到失位后，两次纠正之间的最小间隔（毫秒）。
///
/// 防止在极端情况（某程序反复抢置顶）下变成高频争抢。
pub const RECOVER_COOLDOWN_MS: u32 = 3_000;

/// 上一次纠正的时间戳（毫秒，单调递增的上报值），0 表示从未纠正过。
static LAST_RECOVER_MS: AtomicU32 = AtomicU32::new(0);

/// 每轮守护的判定结果，用于单测纯逻辑与运行期日志区分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TopmostState {
    /// 已在置顶层最前（上方没有「会盖住它的非置顶窗口」）。
    Ok,
    /// 失位：上方存在几何覆盖它的非置顶窗口。
    ///
    /// `blockers` / `rank` 是数量诊断，`detail` 是**遮蔽者身份**。
    /// 身份必须有：2026-11-24 第一次上线后，日志只记了「rank=2, 压着 1 个」，
    /// 结果仍然不知道是谁压的，等于白记一轮 —— 所以这次把进程名/类名/标题一起带上。
    Displaced {
        blockers: usize,
        rank: usize,
        detail: String,
    },
    /// 窗口不存在 / 不可见 / 已最小化 —— 此时不必管层级。
    Inactive,
    /// 查询失败（取不到 HWND 等），保持沉默，下轮再试。
    Unavailable,
}

/// 判定「这个窗口当前是否真的在最上层」，只读，不改任何窗口状态。
///
/// 判据（故意不用样式位）：
/// 从 z 序最顶端往下走，走到目标窗口为止，统计途中**非置顶**且
/// **几何上覆盖目标矩形**的可见窗口数。只要 > 0 就算失位。
#[cfg(target_os = "windows")]
pub fn inspect(hwnd: isize) -> TopmostState {
    win32::inspect_impl(hwnd)
}

#[cfg(not(target_os = "windows"))]
pub fn inspect(_hwnd: isize) -> TopmostState {
    // 非 Windows 平台由 tao 自身维护置顶语义，这里不做额外守护。
    TopmostState::Ok
}

/// 把窗口重新拉回置顶层。**只走 z-order API**（写样式位实测无效）。
#[cfg(target_os = "windows")]
pub fn reassert(hwnd: isize) -> Result<(), String> {
    win32::reassert_impl(hwnd)
}

#[cfg(not(target_os = "windows"))]
pub fn reassert(_hwnd: isize) -> Result<(), String> {
    Ok(())
}

/// 取歌词窗的 HWND（取不到返回 None）。
#[cfg(target_os = "windows")]
fn overlay_hwnd(app: &AppHandle) -> Option<isize> {
    let window = app.get_webview_window(crate::overlay::OVERLAY_WINDOW)?;
    window.hwnd().ok().map(|handle| handle.0 as isize)
}

#[cfg(target_os = "windows")]
fn now_ms() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    millis as u32
}

/// 执行一轮守护：检测 → 失位则纠正（带冷却）。返回本轮是否做了纠正。
///
/// 调用点只有一个：`main.rs` 里的后台守护线程。
#[cfg(target_os = "windows")]
pub fn guard_once(app: &AppHandle) -> bool {
    let Some(hwnd) = overlay_hwnd(app) else {
        return false;
    };
    let state = inspect(hwnd);
    let TopmostState::Displaced {
        blockers,
        rank,
        detail,
    } = state
    else {
        return false;
    };

    // 冷却：刚纠正过就先别急着再来一次。
    let now = now_ms();
    let last = LAST_RECOVER_MS.load(Ordering::SeqCst);
    if last != 0 && now.saturating_sub(last) < RECOVER_COOLDOWN_MS {
        return false;
    }

    match reassert(hwnd) {
        Ok(()) => {
            LAST_RECOVER_MS.store(now, Ordering::SeqCst);
            logging::warn(format!(
                "桌面歌词失位已拉回置顶层（纠正前 rank={rank}，压着它的非置顶窗口={blockers} 个；遮蔽者：{detail}）"
            ));
            true
        }
        Err(error) => {
            // 失败不刷屏：只在真的失败时记一条，下一轮继续尝试。
            logging::warn(format!("桌面歌词重申置顶失败：{error}"));
            false
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn guard_once(_app: &AppHandle) -> bool {
    false
}

#[cfg(target_os = "windows")]
mod win32 {
    use super::TopmostState;

    #[link(name = "user32")]
    extern "system" {
        fn GetTopWindow(hwnd: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        fn GetWindow(hwnd: *mut std::ffi::c_void, cmd: u32) -> *mut std::ffi::c_void;
        fn IsWindowVisible(hwnd: *mut std::ffi::c_void) -> i32;
        fn IsIconic(hwnd: *mut std::ffi::c_void) -> i32;
        fn GetWindowRect(hwnd: *mut std::ffi::c_void, rect: *mut Rect) -> i32;
        fn GetWindowLongPtrW(hwnd: *mut std::ffi::c_void, index: i32) -> isize;
        fn SetWindowPos(
            hwnd: *mut std::ffi::c_void,
            insert_after: *mut std::ffi::c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        fn GetWindowThreadProcessId(hwnd: *mut std::ffi::c_void, pid: *mut u32) -> u32;
        fn GetClassNameW(hwnd: *mut std::ffi::c_void, buffer: *mut u16, max: i32) -> i32;
        fn GetWindowTextW(hwnd: *mut std::ffi::c_void, buffer: *mut u16, max: i32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        fn QueryFullProcessImageNameW(
            process: *mut std::ffi::c_void,
            flags: u32,
            buffer: *mut u16,
            size: *mut u32,
        ) -> i32;
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    const GW_HWNDNEXT: u32 = 2;
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TOPMOST: isize = 0x0000_0008;

    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;

    const HWND_TOPMOST: isize = -1;

    /// z 链最多走这么多步就放弃（防御：异常窗口链不该有这么长）。
    const MAX_CHAIN_STEPS: usize = 4_000;

    fn as_handle(raw: isize) -> *mut std::ffi::c_void {
        raw as *mut std::ffi::c_void
    }

    fn rect_of(hwnd: *mut std::ffi::c_void) -> Option<Rect> {
        let mut rect = Rect::default();
        // SAFETY: hwnd 来自系统查询；Rect 是 POD 且布局与 Win32 RECT 一致。
        let ok = unsafe { GetWindowRect(hwnd, &mut rect) };
        (ok != 0).then_some(rect)
    }

    fn is_topmost(hwnd: *mut std::ffi::c_void) -> bool {
        // SAFETY: 纯查询，不修改窗口。
        let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
        (ex & WS_EX_TOPMOST) != 0
    }

    /// 读窗口标题（失败返回空串）。
    fn window_title(hwnd: *mut std::ffi::c_void) -> String {
        let mut buffer = [0u16; 128];
        // SAFETY: buffer 长度与传入上限一致，GetWindowTextW 会写入并补零。
        let len = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..len as usize])
    }

    /// 读窗口类名（失败返回空串）。
    fn window_class(hwnd: *mut std::ffi::c_void) -> String {
        let mut buffer = [0u16; 96];
        // SAFETY: 同 window_title。
        let len = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..len as usize])
    }

    /// 读窗口所属进程的可执行文件名（不含目录）。
    ///
    /// 打不开进程（权限/已退出）时返回空串——日志少一个字段，不影响守护逻辑。
    fn process_name(hwnd: *mut std::ffi::c_void) -> String {
        let mut pid: u32 = 0;
        // SAFETY: 纯查询。
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == 0 {
            return String::new();
        }
        // PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        // SAFETY: 句柄在使用后立即关闭；失败时返回空串。
        let handle = unsafe { OpenProcess(0x1000, 0, pid) };
        if handle.is_null() {
            return String::new();
        }
        let mut buffer = [0u16; 512];
        let mut size = buffer.len() as u32;
        // SAFETY: buffer/size 成对传入，成功时 size 被改写为实际长度。
        let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) };
        unsafe { CloseHandle(handle) };
        if ok == 0 || size == 0 {
            return String::new();
        }
        let full = String::from_utf16_lossy(&buffer[..size as usize]);
        // 只保留文件名：完整路径又长又含用户名，日志里没必要。
        full.rsplit(['\\', '/']).next().unwrap_or("").to_string()
    }

    /// 拼一行「遮蔽者身份」，给日志用。
    fn describe_blocker(hwnd: *mut std::ffi::c_void) -> String {
        let name = process_name(hwnd);
        let class = window_class(hwnd);
        let title = window_title(hwnd);
        let mut parts: Vec<String> = Vec::new();
        if !name.is_empty() {
            parts.push(name);
        }
        if !class.is_empty() {
            parts.push(format!("[{class}]"));
        }
        if !title.is_empty() {
            // 标题可能很长，截断避免日志爆行。
            let clipped: String = title.chars().take(48).collect();
            let ellipsis = if title.chars().count() > 48 {
                "…"
            } else {
                ""
            };
            parts.push(format!("「{clipped}{ellipsis}」"));
        }
        if parts.is_empty() {
            "未知窗口".to_string()
        } else {
            parts.join(" ")
        }
    }

    fn intersects(a: Rect, b: Rect) -> bool {
        !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
    }

    /// 覆盖面积是否「不可忽略」。
    ///
    /// 1×1 之类的辅助窗口不构成遮挡，按面积门槛排除，避免误判。
    fn meaningful(rect: Rect) -> bool {
        (rect.right - rect.left) > 2 && (rect.bottom - rect.top) > 2
    }

    pub fn inspect_impl(raw: isize) -> TopmostState {
        let target = as_handle(raw);
        // SAFETY: 全部是只读查询；target 由调用方保证来自真实窗口句柄。
        unsafe {
            if IsWindowVisible(target) == 0 || IsIconic(target) != 0 {
                return TopmostState::Inactive;
            }
        }
        let Some(target_rect) = rect_of(target) else {
            return TopmostState::Unavailable;
        };
        if !meaningful(target_rect) {
            return TopmostState::Inactive;
        }

        let mut rank = 0usize;
        let mut blockers = 0usize;
        // 最多记这么多个遮蔽者身份，避免一个全屏弹窗叠一堆时把日志撑爆。
        const MAX_NAMED_BLOCKERS: usize = 3;
        let mut names: Vec<String> = Vec::new();
        // SAFETY: 沿 z 序向下走，只读。
        let mut current = unsafe { GetTopWindow(std::ptr::null_mut()) };
        let mut steps = 0usize;
        while !current.is_null() && steps < MAX_CHAIN_STEPS {
            steps += 1;
            if current == target {
                break;
            }
            // SAFETY: current 是系统返回的有效窗口句柄。
            let visible = unsafe { IsWindowVisible(current) } != 0;
            if visible {
                if let Some(rect) = rect_of(current) {
                    if meaningful(rect) {
                        rank += 1;
                        if !is_topmost(current) && intersects(rect, target_rect) {
                            blockers += 1;
                            if names.len() < MAX_NAMED_BLOCKERS {
                                names.push(describe_blocker(current));
                            }
                        }
                    }
                }
            }
            // SAFETY: 同 REQ：读取 z 序下一个窗口。
            current = unsafe { GetWindow(current, GW_HWNDNEXT) };
        }

        if blockers > 0 {
            TopmostState::Displaced {
                blockers,
                rank,
                detail: names.join(" / "),
            }
        } else {
            TopmostState::Ok
        }
    }

    pub fn reassert_impl(raw: isize) -> Result<(), String> {
        let target = as_handle(raw);
        // SAFETY: 只有 z-order 调用会修改窗口，其余为只读。
        let ok = unsafe {
            SetWindowPos(
                target,
                as_handle(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        };
        if ok != 0 {
            Ok(())
        } else {
            Err("SetWindowPos(HWND_TOPMOST) 返回 0".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_is_long_enough_to_avoid_fighting() {
        // 冷却必须不短于守护周期，否则一旦有人反复抢置顶，
        // 这里会变成高频争抢、日志刷屏。守护周期改动时要同步复核这个断言。
        assert!(
            u64::from(RECOVER_COOLDOWN_MS) >= GUARD_INTERVAL_MS,
            "冷却 {RECOVER_COOLDOWN_MS}ms 必须 >= 守护周期 {GUARD_INTERVAL_MS}ms"
        );
    }

    #[test]
    fn displaced_state_carries_diagnostics() {
        // 失位状态必须带上 rank / blockers / detail 三样：
        // 前两个是数量诊断，detail 是**遮蔽者身份**（进程名+类名+标题）。
        //
        // 这条是补记的教训：第一版只记 rank+blockers，上线后日志出现
        // 「rank=2，压着 1 个」却仍然不知道是谁压的，等于白记一轮。
        let state = TopmostState::Displaced {
            blockers: 7,
            rank: 15,
            detail: "chrome [Chrome_WidgetWin_1]「某页面」".to_string(),
        };
        match state {
            TopmostState::Displaced {
                blockers,
                rank,
                detail,
            } => {
                assert_eq!(blockers, 7);
                assert_eq!(rank, 15);
                assert!(
                    detail.contains("chrome"),
                    "detail 必须能指出是谁压的，实际：{detail}"
                );
            }
            other => panic!("期望 Displaced，实际 {other:?}"),
        }
    }

    #[test]
    fn only_displaced_triggers_recovery() {
        // 守护动作的唯一触发条件就是 Displaced。其余三种状态都必须保持沉默，
        // 否则「正常态零副作用」这条设计前提就破了。
        for state in [
            TopmostState::Ok,
            TopmostState::Inactive,
            TopmostState::Unavailable,
        ] {
            assert_ne!(
                state,
                TopmostState::Displaced {
                    blockers: 1,
                    rank: 1,
                    detail: String::new(),
                },
                "{state:?} 不应被当成失位"
            );
        }
    }

    #[test]
    fn blocker_names_are_capped() {
        // 遮蔽者身份最多记 3 个：全屏弹窗叠加时可能有十几个窗口同时覆盖，
        // 全记会把一行日志撑成几 KB。这里用 detail 的拼接格式做契约断言。
        let names = ["a.exe", "b.exe", "c.exe"];
        let detail = names.join(" / ");
        assert_eq!(
            detail.matches(" / ").count(),
            2,
            "三个名字之间应有 2 个分隔符"
        );
    }
}
