package life.nineli.melodex

import android.content.res.Configuration
import android.os.Build
import android.webkit.WebSettings
import com.getcapacitor.BridgeActivity

/**
 * 让 WebView 的 `prefers-color-scheme` 真正跟随系统深浅色。
 *
 * 为什么需要覆写:Capacitor 的核心不设置 `setAlgorithmicDarkeningAllowed`
 * (AndroidX WebKit) 或 `setForceDark`,在 WebView 110 + targetSdk 36 的组合下,
 * WebView 的 prefers-color-scheme 会停在创建时的默认值 ——
 * 真机实测:系统在浅色/深色之间切换时,页面**完全不跟随**,始终停在深色。
 *
 * 处理方式:
 *   · API 33+ (TIRAMISU):WebSettings.setAlgorithmicDarkeningAllowed(false)。
 *     设为 false 表示"不要用 WebView 自己的强制反色算法",让页面自己按
 *     prefers-color-scheme 决定 —— 这正是我们要的:前端已经有两套完整的 Fluent token。
 *     若设成 true,WebView 会对浅色页面做算法反色,把我们的配色全毁掉。
 *   · API 29~32:只有已废弃的 FORCE_DARK,同样设 off。
 *   · 29 以下:不需要处理(那时 WebView 本就跟随 uiMode)。
 *
 * 另一半在 res/values-night/:窗口底色随系统变,WebView 的 prefers-color-scheme
 * 才有正确的底层依据。两者缺一不可 —— 只改一边都不生效(实测)。
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        registerPlugin(NativePlaybackPlugin::class.java)
        // 返回键必须由原生接管后再交给 JS 返回栈,否则按返回会直接退出 App
        // 而不是先收起弹窗/播放页。详见 SystemBackPlugin 的注释。
        registerPlugin(SystemBackPlugin::class.java)
        super.onCreate(savedInstanceState)
        configureWebViewDarkMode()
        requestNotificationPermission()
    }

    /**
     * 关掉 WebView 的"算法反色",让页面自己按 prefers-color-scheme 渲染。
     * 幂等:可重复调用,成本可忽略。
     */
    private fun configureWebViewDarkMode() {
        val settings: WebSettings = bridge?.webView?.settings ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // API 33+:新接口。false = 不使用强制反色,由页面 CSS 决定。
            settings.isAlgorithmicDarkeningAllowed = false
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // API 29~32:已废弃但仍是唯一可用的开关。FORCE_DARK_OFF = 0。
            @Suppress("DEPRECATION")
            settings.forceDark = WebSettings.FORCE_DARK_OFF
        }
    }

    /**
     * 系统深浅色切换时,Activity 会因 uiMode 变化重建(configChanges 已包含 uiMode)。
     * 重建后 WebView 设置会重置,所以必须再配一次 —— 否则切一次色就失灵。
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        configureWebViewDarkMode()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
            == android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return
        requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST_CODE)
    }

    private companion object {
        const val NOTIFICATION_REQUEST_CODE = 1001
    }
}
