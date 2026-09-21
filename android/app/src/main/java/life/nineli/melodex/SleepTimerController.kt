package life.nineli.melodex

internal enum class SleepTimerMode(val wireName: String) {
    IMMEDIATE("immediate"),
    END_OF_TRACK("track"),
}

internal fun sleepTimerMode(value: String?): SleepTimerMode = when (value?.trim()?.lowercase()) {
    "immediate" -> SleepTimerMode.IMMEDIATE
    "track" -> SleepTimerMode.END_OF_TRACK
    else -> throw IllegalArgumentException("睡眠定时模式必须是 immediate 或 track")
}

internal data class SleepTimerSnapshot(
    val deadlineMs: Long,
    val mode: SleepTimerMode,
    val pendingEndOfTrack: Boolean,
)

internal interface SleepTimerScheduler {
    fun postDelayed(task: Runnable, delayMs: Long)
    fun removeCallbacks(task: Runnable)
}

internal interface SleepTimerPlayback {
    val isPlaying: Boolean
    fun pause()
    fun setPauseAtEndOfMediaItems(enabled: Boolean)
}

/**
 * Service-owned timer. The web layer only supplies an absolute wall-clock deadline;
 * the service keeps the runnable alive while the MediaSession remains active.
 */
internal class SleepTimerController(
    private val scheduler: SleepTimerScheduler,
    private val playback: SleepTimerPlayback,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    private var generation = 0L
    private var task: Runnable? = null
    private var timer: SleepTimerSnapshot? = null

    @Synchronized
    fun set(deadlineMs: Long, mode: SleepTimerMode) {
        require(deadlineMs > 0L) { "睡眠定时截止时间无效" }
        clearLocked()
        val generationAtSchedule = ++generation
        timer = SleepTimerSnapshot(deadlineMs, mode, pendingEndOfTrack = false)
        val scheduledTask = Runnable {
            synchronized(this) {
                if (generationAtSchedule != generation) return@Runnable
                task = null
                onDeadlineLocked()
            }
        }
        task = scheduledTask
        scheduler.postDelayed(scheduledTask, (deadlineMs - nowMs()).coerceAtLeast(0L))
    }

    @Synchronized
    fun clear() {
        clearLocked()
    }

    @Synchronized
    fun snapshot(): SleepTimerSnapshot? = timer

    /** Called by PlaybackService when Media3 reports a playWhenReady transition. */
    @Synchronized
    fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        val current = timer ?: return
        if (!playWhenReady
            && current.pendingEndOfTrack
            && reason == androidx.media3.common.Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM
        ) {
            playback.setPauseAtEndOfMediaItems(false)
            timer = null
        }
    }

    private fun onDeadlineLocked() {
        val current = timer ?: return
        if (current.mode == SleepTimerMode.END_OF_TRACK && playback.isPlaying) {
            playback.setPauseAtEndOfMediaItems(true)
            timer = current.copy(pendingEndOfTrack = true)
            return
        }
        playback.setPauseAtEndOfMediaItems(false)
        timer = null
        playback.pause()
    }

    private fun clearLocked() {
        generation++
        task?.let(scheduler::removeCallbacks)
        task = null
        if (timer?.pendingEndOfTrack == true) {
            playback.setPauseAtEndOfMediaItems(false)
        }
        timer = null
    }
}
