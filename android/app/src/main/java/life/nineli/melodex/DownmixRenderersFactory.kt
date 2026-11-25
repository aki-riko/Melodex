package life.nineli.melodex

import android.content.Context
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.AudioProcessorChain
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.SilenceSkippingAudioProcessor

// 把 QuadDownmix 接进 ExoPlayer 的音频输出链路。
//
// ## 为什么改这里
//
// ExoPlayer.Builder 没有 setAudioSink / setAudioProcessorChain 这类入口(已逐条核对
// media3 1.11.1 的 Builder 公开方法)。可插入的位置只有两个:
//   ① DefaultRenderersFactory.buildAudioSink(context, floatOutput, playbackParams)
//      —— protected 钩子, 默认实现就是 new DefaultAudioSink.Builder(context)...build()
//   ② 自定义 RenderersFactory 自己 new MediaCodecAudioRenderer(...)
// 本类选 ①: 只覆盖一个方法, 视频/字幕等其余渲染器完全保持 media3 默认, 影响面最小。
//
// ## 为什么自己拼链, 而不是 Builder.setAudioProcessors
//
// DefaultAudioSink.Builder.setAudioProcessors(...) 会用传入数组**整个替换**默认链,
// 默认链里的 SilenceSkippingAudioProcessor(跳过静音) 与 SonicAudioProcessor(变速变调)
// 会一起消失, 而本项目的倍速/静音跳过行为依赖它们。
//
// ## 为什么用三参构造而不是单参构造
//
// DefaultAudioProcessorChain 有两个构造:
//   · 单参 (AudioProcessor...)  —— 内部 new 一套 SilenceSkipping + Sonic **追加在数组末尾**
//   · 三参 (数组, SilenceSkipping, Sonic) —— 由调用方给定三者
// 降混处理器必须夹在 Sonic **之前**(先降混成 2 声道, 再让 Sonic 做时间伸缩;
// 反过来 Sonic 要在 4 声道数据上跑变速, 路径和缓存都更容易出问题)。
// 用单参构造无法把降混插到 Sonic 前面, 所以这里用三参构造显式指定顺序:
//   传入数组 = [降混], 再显式给 SilenceSkipping + Sonic
//   最终链 = [降混, SilenceSkipping, Sonic]
//
// ★ 顺序说明: 三参构造内部把"传入数组"放在最前, 然后依次追加
//   SilenceSkippingAudioProcessor、SonicAudioProcessor(见其字节码:
//   arraycopy(传入数组) → 末尾补两个)。所以 [降混] + 两个默认 = 降混在最前。
//   降混在最前是对的: 4 声道一进处理器就先折叠成 2 声道, 后面所有处理器(Sonic、
//   静音跳过、AudioTrack)只需要处理立体声, 与"库里 668 首本来就是立体声"完全同一条路径。

internal class DownmixRenderersFactory(context: Context) : DefaultRenderersFactory(context) {

    override fun buildAudioSink(
        context: Context,
        enableFloatOutput: Boolean,
        enableAudioTrackPlaybackParams: Boolean,
    ): AudioSink {
        val chain = DownmixAudioProcessorChain()
        return DefaultAudioSink.Builder(context)
            .setEnableFloatOutput(enableFloatOutput)
            .setEnableAudioOutputPlaybackParameters(enableAudioTrackPlaybackParams)
            .setAudioProcessorChain(chain)
            .build()
    }

    // 链顺序 = [降混] → SilenceSkipping → Sonic。
    //
    // 降混必须排第一: 4 声道数据一进链就折叠成 2 声道, 之后 Sonic/静音跳过/AudioTrack
    // 全都只面对立体声 —— 与库里那 668 首原生立体声走完全相同的路径, 不引入新的
    // 多声道路径风险。
    private class DownmixAudioProcessorChain : AudioProcessorChain {

        private val silenceSkipping = SilenceSkippingAudioProcessor()
        private val sonic = SonicAudioProcessor()
        private val downmix: AudioProcessor = QuadDownmix.createProcessor()

        // 用三参构造自己拼, 这样才能把降混放在 Sonic 之前(单参构造会把传入数组放最前,
        // 但随后自动追加的 Sonic 永远在它后面 —— 那个顺序其实也满足"降混在 Sonic 前",
        // 只是无法控制 SilenceSkipping 与降混的相对关系; 三参构造让三者完全显式)。
        private val delegate = DefaultAudioSink.DefaultAudioProcessorChain(
            arrayOf(downmix),
            silenceSkipping,
            sonic,
        )

        override fun getAudioProcessors(): Array<AudioProcessor> = delegate.getAudioProcessors()

        override fun applyPlaybackParameters(playbackParameters: PlaybackParameters): PlaybackParameters =
            delegate.applyPlaybackParameters(playbackParameters)

        override fun applySkipSilenceEnabled(skipSilenceEnabled: Boolean): Boolean =
            delegate.applySkipSilenceEnabled(skipSilenceEnabled)

        override fun getMediaDuration(mediaDurationUs: Long): Long =
            delegate.getMediaDuration(mediaDurationUs)

        override fun getSkippedOutputFrameCount(): Long = delegate.getSkippedOutputFrameCount()
    }
}
