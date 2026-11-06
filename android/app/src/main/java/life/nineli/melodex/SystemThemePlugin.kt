package life.nineli.melodex

import android.content.res.Configuration
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 系统深浅色桥。
 *
 * 为什么要这个插件(而不是直接用 CSS 的 prefers-color-scheme):
 * 真机实测,在本项目的形态下(WebView + server.url 加载远端站点)
 * `matchMedia('(prefers-color-scheme: dark)')` **报告的与系统实际不符** ——
 * 系统处于浅色时它报 dark,于是「跟随系统」永远解析成深色。
 *
 * 而 `resources.configuration.uiMode` 是 Android 侧的唯一真相,
 * 直接读它没有任何中间层。所以这里把它暴露给 JS,前端在 Android 上
 * 优先用它、只在 Web 端才退回 matchMedia。
 *
 * 这里只做"读",不做"监听":uiMode 变化会走 Activity 的
 * onConfigurationChanged(已在 MainActivity 声明),由那里 notify 一次。
 */
@CapacitorPlugin(name = "SystemTheme")
class SystemThemePlugin : Plugin() {

    private fun isSystemDark(): Boolean {
        val mode = activity?.resources?.configuration?.uiMode
            ?.and(Configuration.UI_MODE_NIGHT_MASK)
        return mode == Configuration.UI_MODE_NIGHT_YES
    }

    /** 查询当前系统是否为深色。同步语义,JS 侧用 Promise 接。 */
    @PluginMethod
    fun getSystemTheme(call: PluginCall) {
        call.resolve(JSObject().put("dark", isSystemDark()))
    }

    /** 让 JS 主动订阅:uiMode 变化时由 MainActivity 调 notifyThemeChange(). */
    @PluginMethod
    fun subscribe(call: PluginCall) {
        call.resolve()
    }

    /** 供 MainActivity 在 onConfigurationChanged 时调用。 */
    fun notifyThemeChange() {
        notifyListeners("change", JSObject().put("dark", isSystemDark()))
    }
}
