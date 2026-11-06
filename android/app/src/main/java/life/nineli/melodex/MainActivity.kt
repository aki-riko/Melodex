package life.nineli.melodex

import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.webkit.WebSettings
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(NativePlaybackPlugin::class.java)
        // 返回键必须由原生接管后再交给 JS 返回栈,否则按返回会直接退出 App
        // 而不是先收起弹窗/播放页。详见 SystemBackPlugin 的注释。
        registerPlugin(SystemBackPlugin::class.java)
        // 系统深浅色的**权威来源**。真机实测:WebView 的 prefers-color-scheme
        // 在本项目形态下报的值与系统不符,所以前端在 Android 上读这个插件。
        registerPlugin(SystemThemePlugin::class.java)
        super.onCreate(savedInstanceState)
        configureWebViewDarkMode()
        requestNotificationPermission()
    }

    /**
     * 关掉 WebView 的"算法反色",让页面自己按 token 渲染。
     *
     * 为什么必须关:本项目前端已有完整的深浅两套 Fluent token,配色由 CSS 全权决定。
     * 若允许算法反色,WebView 会对浅色页面强行做反色运算,把调过的对比度全部毁掉。
     *
     * 注意:光有这一步**不足以**让 prefers-color-scheme 跟随系统(真机实测),
     * 所以前端改用 SystemThemePlugin 读 uiMode —— 两者分工是:
     * 这个开关保证"页面不被反色",插件保证"知道系统到底是深还是浅"。
     */
    private fun configureWebViewDarkMode() {
        val settings: WebSettings = bridge?.webView?.settings ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            settings.isAlgorithmicDarkeningAllowed = false
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            settings.forceDark = WebSettings.FORCE_DARK_OFF
        }
    }

    /**
     * 系统深浅色切换时,Activity 会因 uiMode 变化走这里。
     * 需要做两件事:
     *   1. 重配 WebView(重建后设置会重置,不重配就会"切一次色就失灵");
     *   2. 通知 JS —— 前端据此重新解析主题,「跟随系统」才会真的跟着变。
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        configureWebViewDarkMode()
        // 插件可能尚未注册完成(冷启动阶段),空安全处理。
        // PluginHandle.instance 是 private 字段,必须走 getInstance()。
        val plugin = bridge?.getPlugin("SystemTheme")?.instance as? SystemThemePlugin
        plugin?.notifyThemeChange()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED
        ) return
        requestPermissions(
            arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
            NOTIFICATION_REQUEST_CODE,
        )
    }

    private companion object {
        const val NOTIFICATION_REQUEST_CODE = 1001
    }
}
