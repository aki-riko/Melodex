package life.nineli.melodex

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(NativePlaybackPlugin::class.java)
        // 返回键必须由原生接管后再交给 JS 返回栈,否则按返回会直接退出 App
        // 而不是先收起弹窗/播放页。详见 SystemBackPlugin 的注释。
        registerPlugin(SystemBackPlugin::class.java)
        super.onCreate(savedInstanceState)
        requestNotificationPermission()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST_CODE)
    }

    private companion object {
        const val NOTIFICATION_REQUEST_CODE = 1001
    }
}
