package life.nineli.melodex

import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import kotlin.math.abs
import kotlin.math.sqrt

// 多声道 → 立体声 降混(2026-11 新增)。
//
// ## 为什么要这个
//
// QQ 音乐的 OGG 640k 档(O801)交付的是 **4 声道 quad**(FL/FR/BL/BR)文件, 库里有 13 首
// 是这样。PC 的 Chromium/FFmpeg 解码时会自动折叠四声道, 听到的是完整的; 但 Android
// 上只有 2 个物理输出声道(内置扬声器/耳机), 而 **CDD 对 Vorbis 多声道只要求"能解码",
// 明确允许在播放阶段降混**(不像 AAC 那样强制"解码后不降混")。于是厂商解码器只把前
// 两个声道送进输出, 后两个声道被丢掉 —— 表现为「贝斯/底鼓整片消失, 像无伴奏清唱」。
//
// ExoPlayer 默认的 AudioProcessorChain 里**没有声道混音器**
// (DefaultAudioProcessorChain 只有 SilenceSkippingAudioProcessor + SonicAudioProcessor),
// 所以必须自己挂一个 ChannelMixingAudioProcessor 并给出 4→2 的矩阵。
//
// ## 为什么不能直接用内置系数
//
// ChannelMixingMatrix.createForConstantPower(4, 2) 给出的其实是
// `L = 1.0*FL + 0.7071*BL`(行和 1.7071, 理论可达 +4.65 dB)。实测库里 13 首 quad:
// 「千梦」「那三两句晚安」两首峰值直接顶到 **0.0 dB**(削顶), 其余多数也在 -1 dB 上下。
// 所以本模块自己给行归一(每行系数和 = 1)的矩阵。
//
// ## 系数来源
//
// 采用 RFC 7845 §5.1.1.5 Figure 5 的 quad 降混矩阵(该文档同时是 Vorbis 的声道映射
// 规范 —— 4 声道 Vorbis 的声道顺序是 FL/FR/BL/BR, 与这里一致):
//
//   L = 0.422650*FL + 0.366025*BL + 0.211325*BR
//   R = 0.422650*FR + 0.211325*BL + 0.366025*BR
//
// 系数取 1、√3/2、1/2 再乘归一化因子 1/(1 + √3/2 + 1/2) = 0.422650, 每行和恰为 1,
// 理论增益上限 0.00 dB —— 不会因为降混重新削顶。
//
// ★ 注意它与「简单丢后声道」的关键区别: 后声道不是前声道的复制品。实测这 13 首的前后
//   声道互相关接近 0(独立内容), 且 20-150Hz 频段前声场比后声场低 20 dB 以上 ——
//   也就是说低频几乎全在后声道里。丢掉后声道 = 低音整块没了。

internal object QuadDownmix {
    // 4 声道输入 → 立体声输出时, 每行(每个输出声道)的系数和必须 <= 1。
    // 数值直接来自 RFC 7845 Figure 5, 不在这里重新推导, 以免两处漂移。
    const val FL_TO_L = 0.422650f
    const val BL_TO_L = 0.366025f
    const val BR_TO_L = 0.211325f
    const val FR_TO_R = 0.422650f
    const val BL_TO_R = 0.211325f
    const val BR_TO_R = 0.366025f

    // 只降混这个声道数的输入。2 声道及以下的立体声/单声道本来就不缺内容,
    // 不能被这套矩阵碰到。
    const val LOWERED_CHANNEL_COUNT = 4
    const val OUTPUT_CHANNEL_COUNT = 2

    // 系数数组的索引顺序由 ChannelMixingMatrix 决定, 是 **行优先(input-major)**:
    //   coefficients[输入声道 * outputChannelCount + 输出声道]
    // 依据(两处独立核对, 不是推测):
    //   ① 源码 `getMixingCoefficient(int inputChannel, int outputChannel)` 的签名,
    //      实现是 `coefficients[inputChannel * outputChannelCount + outputChannel]`;
    //   ② 实测反推 —— 用内置 createForConstantPower(4,2) 回读:
    //        getMixingCoefficient(0,*)=[1.0000, 0.0000]   // FL → L
    //        getMixingCoefficient(1,*)=[0.7071, 0.0000]   // ...
    //      而内置矩阵注释写的是 `left = 1.0*FL + 0.7071*BL`, 说明 media3 的 quad 布局是
    //      [FL, BL, FR, BR] —— 即被索引第 1 项实际是 BACK_LEFT。
    //
    // 因此 4 输入 → 2 输出要排成 4 行 × 2 列 = 8 个数, 行 = 输入声道(FL, FR, BL, BR),
    // 列 = 输出声道(L, R)。
    fun quadToStereoCoefficients(): FloatArray = floatArrayOf(
        // 输入 FL: 到 L, 到 R
        FL_TO_L, 0f,
        // 输入 FR: 到 L, 到 R
        0f, FR_TO_R,
        // 输入 BL: 到 L, 到 R
        BL_TO_L, BL_TO_R,
        // 输入 BR: 到 L, 到 R
        BR_TO_L, BR_TO_R,
    )

    // 每个输出声道(列)的系数和(用于门禁断言"不会因降混放大到削顶")。
    fun rowSums(): List<Float> = listOf(
        // L 列: FL + BL + BR
        FL_TO_L + BL_TO_L + BR_TO_L,
        // R 列: FR + BL + BR
        FR_TO_R + BL_TO_R + BR_TO_R,
    )

    fun buildQuadToStereoMatrix(): ChannelMixingMatrix = ChannelMixingMatrix(
        LOWERED_CHANNEL_COUNT,
        OUTPUT_CHANNEL_COUNT,
        quadToStereoCoefficients(),
    )

    fun identityCoefficients(channelCount: Int): FloatArray =
        FloatArray(channelCount * channelCount) { index ->
            val row = index / channelCount
            val column = index % channelCount
            if (row == column) 1f else 0f
        }

    // 构造挂在 ExoPlayer 音频链上的处理器。
    //
    // ★ 为什么每个声道数都要注册, 而不是只注册 4→2:
    //   ChannelMixingAudioProcessor.onConfigure 在 matrixByInputChannelCount 里查不到
    //   当前输入声道数时, 会**直接抛 UnhandledAudioFormatException**
    //   ("No mixing matrix set for input channel count=…")。只注册 4→2 会让所有普通
    //   立体声歌曲(库里 668 首)当场无法播放; 而未知的 5/6/8 声道源(某些影视原声)同样
    //   会炸。所以: 1~2 声道与 4 声道以外的全部注册**恒等矩阵**
    //   (isIdentity()==true → onConfigure 返回 NOT_SET → 处理器自行停用, 零副作用),
    //   只有 4 声道走真正的降混。
    //
    //   实测 ChannelMixingMatrix 的系数校验(checkCoefficientsValid)只拒绝负数,
    //   不做行和归一约束, 因此恒等矩阵与行归一的降混矩阵都能通过校验。
    fun createProcessor(): ChannelMixingAudioProcessor = ChannelMixingAudioProcessor().apply {
        for (matrix in matricesToRegister()) {
            putChannelMixingMatrix(matrix)
        }
    }

    // 要注册的全部矩阵。**抽成纯函数是为了可测** —— ChannelMixingAudioProcessor 内部用
    // android.util.SparseArray 存矩阵, 在 JVM 单元测试里没有实现会抛
    // RuntimeException("Method put in android.util.SparseArray not mocked"), 所以测试
    // 改为断言这个纯函数产出的矩阵清单, 而不是真的 new 一个处理器。
    fun matricesToRegister(): List<ChannelMixingMatrix> = buildList {
        // 兜底: 1~8 声道全部先注册恒等矩阵。
        for (channels in 1..8) {
            add(ChannelMixingMatrix(channels, channels, identityCoefficients(channels)))
        }
        // 唯一真正生效的一条: 4 声道 → 立体声。
        add(buildQuadToStereoMatrix())
    }

    fun identityStereoCoefficients(): FloatArray = identityCoefficients(OUTPUT_CHANNEL_COUNT)

    // 供测试/诊断: 降混矩阵的行归一是否成立(理论 1.0)。
    fun isRowNormalized(tolerance: Float = 1e-4f): Boolean =
        rowSums().all { abs(it - 1f) <= tolerance }

    // 归一化因子的解析式, 供测试逐位复核上面的常量。
    fun normalizationFactor(): Float = (1.0 / (1.0 + sqrt(3.0) / 2.0 + 0.5)).toFloat()
}
