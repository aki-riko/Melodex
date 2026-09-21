package life.nineli.melodex

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SleepTimerControllerTest {
    private class FakeScheduler : SleepTimerScheduler {
        var task: Runnable? = null
        var delayMs = -1L
        override fun postDelayed(task: Runnable, delayMs: Long) {
            this.task = task
            this.delayMs = delayMs
        }

        override fun removeCallbacks(task: Runnable) {
            if (this.task === task) this.task = null
        }

        fun fire() {
            val current = task ?: error("没有待执行任务")
            task = null
            current.run()
        }
    }

    private class FakePlayback(var playing: Boolean = true) : SleepTimerPlayback {
        var pauseCalls = 0
        val pauseAtEndCalls = mutableListOf<Boolean>()
        override val isPlaying: Boolean get() = playing
        override fun pause() {
            pauseCalls++
            playing = false
        }

        override fun setPauseAtEndOfMediaItems(enabled: Boolean) {
            pauseAtEndCalls += enabled
        }
    }

    @Test
    fun immediateDeadlinePausesFromServiceTimer() {
        val scheduler = FakeScheduler()
        val playback = FakePlayback()
        val controller = SleepTimerController(scheduler, playback, nowMs = { 1_000L })

        controller.set(6_000L, SleepTimerMode.IMMEDIATE)
        assertEquals(5_000L, scheduler.delayMs)
        scheduler.fire()

        assertEquals(1, playback.pauseCalls)
        assertNull(controller.snapshot())
    }

    @Test
    fun trackDeadlineArmsMedia3AndWaitsForCurrentTrack() {
        val scheduler = FakeScheduler()
        val playback = FakePlayback()
        val controller = SleepTimerController(scheduler, playback, nowMs = { 1_000L })

        controller.set(1_000L, SleepTimerMode.END_OF_TRACK)
        scheduler.fire()

        assertEquals(0, playback.pauseCalls)
        assertEquals(listOf(true), playback.pauseAtEndCalls)
        assertTrue(controller.snapshot()?.pendingEndOfTrack == true)

        controller.onPlayWhenReadyChanged(
            false,
            androidx.media3.common.Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM,
        )
        assertEquals(listOf(true, false), playback.pauseAtEndCalls)
        assertNull(controller.snapshot())
    }

    @Test
    fun manualPauseDoesNotCancelPendingTrackStop() {
        val scheduler = FakeScheduler()
        val playback = FakePlayback()
        val controller = SleepTimerController(scheduler, playback, nowMs = { 1_000L })

        controller.set(1_000L, SleepTimerMode.END_OF_TRACK)
        scheduler.fire()
        controller.onPlayWhenReadyChanged(
            false,
            androidx.media3.common.Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST,
        )

        assertTrue(controller.snapshot()?.pendingEndOfTrack == true)
        assertEquals(listOf(true), playback.pauseAtEndCalls)
    }

    @Test
    fun trackDeadlinePausesImmediatelyWhenAlreadyStopped() {
        val scheduler = FakeScheduler()
        val playback = FakePlayback(playing = false)
        val controller = SleepTimerController(scheduler, playback, nowMs = { 1_000L })

        controller.set(1_000L, SleepTimerMode.END_OF_TRACK)
        scheduler.fire()

        assertEquals(1, playback.pauseCalls)
        assertEquals(listOf(false), playback.pauseAtEndCalls)
        assertNull(controller.snapshot())
    }

    @Test
    fun clearCancelsOldDeadlineAndDisablesPendingTrackStop() {
        val scheduler = FakeScheduler()
        val playback = FakePlayback()
        val controller = SleepTimerController(scheduler, playback, nowMs = { 1_000L })

        controller.set(2_000L, SleepTimerMode.END_OF_TRACK)
        scheduler.fire()
        controller.clear()

        assertEquals(listOf(true, false), playback.pauseAtEndCalls)
        assertNull(controller.snapshot())
        assertFalse(scheduler.task != null)
    }

    @Test
    fun replacingTimerIgnoresTheOldRunnable() {
        val scheduler = FakeScheduler()
        val playback = FakePlayback()
        val controller = SleepTimerController(scheduler, playback, nowMs = { 1_000L })

        controller.set(10_000L, SleepTimerMode.IMMEDIATE)
        val oldTask = scheduler.task ?: error("旧任务未创建")
        controller.set(20_000L, SleepTimerMode.IMMEDIATE)
        oldTask.run()

        assertEquals(0, playback.pauseCalls)
        scheduler.fire()
        assertEquals(1, playback.pauseCalls)
    }

    @Test
    fun invalidModeAndDeadlineAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { sleepTimerMode("later") }
        assertThrows(IllegalArgumentException::class.java) { sleepTimerMode(null) }

        val controller = SleepTimerController(FakeScheduler(), FakePlayback(), nowMs = { 1_000L })
        assertThrows(IllegalArgumentException::class.java) {
            controller.set(0L, SleepTimerMode.IMMEDIATE)
        }
    }
}
