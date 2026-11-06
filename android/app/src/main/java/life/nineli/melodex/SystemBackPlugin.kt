package life.nineli.melodex

import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.addCallback
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 物理返回键桥。
 *
 * 为什么必须有这个插件:Melodex 的 APK 是 Capacitor 外壳加载远端站点
 * (server.url = https://music.9li.life)。此前**完全没有**处理返回键 ——
 * BridgeActivity 没有覆写 onBackPressed,Capacitor 8 核心也不转发按键,
 * 因此按返回键在任何页面都会**直接退出 App**,而不是先收起打开的弹窗/播放页。
 *
 * 现在的分工:
 *   · 原生只负责"按键被按下"这件事,并把判断权交给 JS 的返回栈;
 *   · JS 回 resolve({handled:true}) 表示已消费,原生什么都不做;
 *   · JS 回 handled:false 表示栈空,原生才 moveTaskToBack(退到后台)。
 *
 * 为什么"退到后台"而不是 finish():音乐 App 被返回键直接杀掉会中断播放并
 * 丢掉 MediaSession;退到后台与系统"返回"的通用语义一致,用户从最近任务
 * 回来仍是原状态。真正的退出走系统划掉任务。
 */
@CapacitorPlugin(name = "SystemBack")
class SystemBackPlugin : Plugin() {

    /** 等待 JS 回话的返回键事件;同一时刻只可能有一次按键在途。 */
    private var pendingCall: PluginCall? = null
    private var callback: OnBackPressedCallback? = null

    override fun load() {
        super.load()
        // addCallback 必须在主线程;load() 即在主线程。
        // activity 在 Plugin 里是 AppCompatActivity,但编译器看到的是 Activity 接口,
        // 所以显式取 OnBackPressedDispatcher。
        val host = activity as? androidx.activity.ComponentActivity
        callback = host?.onBackPressedDispatcher?.addCallback(host) {
            dispatchBackToWeb()
        }
    }

    /**
     * 让 WebView 尝试消费这次返回。
     * 这里直接 evaluateJavascript 派发一个 DOM 事件,而不是依赖 Capacitor 的
     * notifyListeners:后者需要 JS 侧先 addListener 建立回调通道,在冷启动
     * 或 JS 还没挂好监听时会静默丢失 —— 而返回键被吞掉的体验比"直接退出"更糟
     * (用户会觉得按了没反应)。
     */
    private fun dispatchBackToWeb() {
        val webView: WebView? = bridge?.webView
        if (webView == null) {
            exitToBackground()
            return
        }
        webView.evaluateJavascript(
            """
            (function () {
              try {
                var ev = new CustomEvent('melodex:systemback', { cancelable: true });
                // dispatchEvent 返回 false 表示有人 preventDefault() 了 → 已消费
                var notPrevented = window.dispatchEvent(ev);
                return notPrevented ? 'unhandled' : 'handled';
              } catch (e) {
                return 'unhandled';
              }
            })();
            """.trimIndent(),
        ) { result ->
            // 判定逻辑抽在 SystemBackResult 里并有单测覆盖 ——
            // 用 contains("handled") 会把 "unhandled" 也判成已处理,
            // 结果是返回键被吞、App 永远退不出去(这个坑必须钉住)。
            if (!SystemBackResult.isHandled(result)) exitToBackground()
        }
    }

    private fun exitToBackground() {
        activity?.moveTaskToBack(true)
    }

    /**
     * 供 JS 显式调用(可选):某些场景 JS 已处理完但想让 App 退到后台。
     */
    @PluginMethod
    fun exit(call: PluginCall) {
        activity?.moveTaskToBack(true)
        call.resolve()
    }

    /**
     * 供 JS 查询原生是否已接管返回键(诊断用)。
     */
    @PluginMethod
    fun isActive(call: PluginCall) {
        call.resolve(JSObject().put("active", callback?.isEnabled == true))
    }

    override fun handleOnDestroy() {
        callback?.remove()
        callback = null
        pendingCall = null
        super.handleOnDestroy()
    }
}
