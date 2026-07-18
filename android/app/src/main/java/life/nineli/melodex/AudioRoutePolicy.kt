package life.nineli.melodex

import android.media.AudioDeviceInfo
import android.view.KeyEvent

internal data class AudioRouteDevice(
    val id: Int,
    val type: Int,
)

internal data class RecentlyDisconnectedRoute(
    val device: AudioRouteDevice,
    val disconnectedAtMs: Long,
)

internal fun isPrivateAudioRoute(type: Int): Boolean = when (type) {
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_USB_ACCESSORY,
    AudioDeviceInfo.TYPE_USB_DEVICE,
    AudioDeviceInfo.TYPE_USB_HEADSET,
    AudioDeviceInfo.TYPE_HEARING_AID,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_BLE_SPEAKER,
    AudioDeviceInfo.TYPE_BLE_BROADCAST,
    AudioDeviceInfo.TYPE_AUX_LINE,
    AudioDeviceInfo.TYPE_LINE_ANALOG,
    AudioDeviceInfo.TYPE_LINE_DIGITAL,
    AudioDeviceInfo.TYPE_DOCK,
    AudioDeviceInfo.TYPE_DOCK_ANALOG,
    AudioDeviceInfo.TYPE_HDMI,
    AudioDeviceInfo.TYPE_HDMI_ARC,
    AudioDeviceInfo.TYPE_HDMI_EARC,
    -> true

    else -> false
}

internal fun isDeferredMediaPauseKey(keyCode: Int): Boolean = when (keyCode) {
    KeyEvent.KEYCODE_MEDIA_PAUSE,
    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
    KeyEvent.KEYCODE_HEADSETHOOK,
    -> true

    else -> false
}

internal fun routedPrivateDisconnects(
    previousRoute: Set<AudioRouteDevice>,
    removedDevices: Set<AudioRouteDevice>,
    disconnectedAtMs: Long,
): List<RecentlyDisconnectedRoute> = removedDevices
    .asSequence()
    .filter(previousRoute::contains)
    .filter { isPrivateAudioRoute(it.type) }
    .map { RecentlyDisconnectedRoute(it, disconnectedAtMs) }
    .toList()

internal fun shouldPauseForNoisyRoute(
    currentRoute: Set<AudioRouteDevice>,
    recentlyDisconnectedRoutes: Collection<RecentlyDisconnectedRoute>,
    nowMs: Long,
    evidenceWindowMs: Long,
): Boolean {
    if (currentRoute.any { isPrivateAudioRoute(it.type) }) return true
    return recentlyDisconnectedRoutes.any { route ->
        isPrivateAudioRoute(route.device.type) &&
            nowMs >= route.disconnectedAtMs &&
            nowMs - route.disconnectedAtMs <= evidenceWindowMs
    }
}
