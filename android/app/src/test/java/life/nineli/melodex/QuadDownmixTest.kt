package life.nineli.melodex

import androidx.media3.common.audio.ChannelMixingMatrix
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

// QuadDownmix 的门禁测试。
//
// 这些断言锁的是「13 首 quad OGG 在手机上听不到低频」那次事故的每一环前提。
// 后续任何人改动系数、声道数或注册范围, 都会在这里立刻红。
//
// ★ 关于矩阵索引方向的教训(本类第一版就是错的):
//   ChannelMixingMatrix.getMixingCoefficient(a, b) 的第一个参数是**输入声道**,
//   第二个才是输出声道; 系数数组是 **input-major** 行优先。
//   本类用「与内置 createForConstantPower(4,2) 逐项对比」的方式把这个方向钉死,
//   而不是靠读注释 —— 注释里写的声道排列与索引实际含义有过不一致。
class QuadDownmixTest {

    // ── 系数必须与 RFC 7845 §5.1.1.5 Figure 5 逐位一致 ──────────────────────────
    //
    // 为什么钉这么死: 直觉上「丢后声道」或「FL + 0.7071*BL」都像是对的, 但实测前者让
    // 低频整块消失(20-150Hz 掉 21 dB), 后者在两首歌上直接削顶到 0.0 dB。
    // 只有 RFC 这套行归一的系数既保内容又不削顶, 不允许悄悄换成别的。
    @Test
    fun quadToStereoCoefficientsMatchRfc7845Figure5() {
        val normalized = QuadDownmix.normalizationFactor()
        // 归一化因子 = 1 / (1 + √3/2 + 1/2)
        assertEquals(0.422650f, normalized, 1e-6f)
        // 原始系数 1、√3/2、1/2 乘归一化因子
        assertEquals(normalized * 1.0f, QuadDownmix.FL_TO_L, 1e-6f)
        assertEquals(normalized * (sqrt(3.0) / 2.0).toFloat(), QuadDownmix.BL_TO_L, 1e-6f)
        assertEquals(normalized * 0.5f, QuadDownmix.BR_TO_L, 1e-6f)
        assertEquals(normalized * 1.0f, QuadDownmix.FR_TO_R, 1e-6f)
        assertEquals(normalized * 0.5f, QuadDownmix.BL_TO_R, 1e-6f)
        assertEquals(normalized * (sqrt(3.0) / 2.0).toFloat(), QuadDownmix.BR_TO_R, 1e-6f)
    }

    // ── 每个输出声道的系数和必须 <= 1, 否则降混本身会削顶 ──────────────────────
    @Test
    fun everyRowSumDoesNotExceedUnity() {
        for (sum in QuadDownmix.rowSums()) {
            assertTrue("系数和 $sum 超过 1.0 会在降混阶段重新削顶", sum <= 1f + 1e-6f)
        }
    }

    @Test
    fun rowSumsAreNormalizedToUnity() {
        assertTrue("降混矩阵必须是行归一的(每列和 = 1)", QuadDownmix.isRowNormalized())
    }

    // ── 系数数组布局: coefficients[输入声道 * outputChannelCount + 输出声道] ──
    //
    // 方向由 media3 源码签名 + 内置矩阵实测回读双重确认。写反会静默串声道:
    // 表现不再是"没低频", 而是"左右声道被混到一起去", 更难排查。
    @Test
    fun coefficientArrayIsLaidOutByInputChannelMajorOrder() {
        val matrix = QuadDownmix.buildQuadToStereoMatrix()
        assertEquals(4, matrix.inputChannelCount)
        assertEquals(2, matrix.outputChannelCount)

        // 输入 FL(0): 只喂给 L, 不给 R
        assertEquals(QuadDownmix.FL_TO_L, matrix.getMixingCoefficient(0, 0), 1e-6f)
        assertEquals(0f, matrix.getMixingCoefficient(0, 1), 1e-6f)
        // 输入 FR(1): 只喂给 R, 不给 L
        assertEquals(0f, matrix.getMixingCoefficient(1, 0), 1e-6f)
        assertEquals(QuadDownmix.FR_TO_R, matrix.getMixingCoefficient(1, 1), 1e-6f)
        // 输入 BL(2): 同时喂给 L 与 R
        assertEquals(QuadDownmix.BL_TO_L, matrix.getMixingCoefficient(2, 0), 1e-6f)
        assertEquals(QuadDownmix.BL_TO_R, matrix.getMixingCoefficient(2, 1), 1e-6f)
        // 输入 BR(3): 同时喂给 L 与 R
        assertEquals(QuadDownmix.BR_TO_L, matrix.getMixingCoefficient(3, 0), 1e-6f)
        assertEquals(QuadDownmix.BR_TO_R, matrix.getMixingCoefficient(3, 1), 1e-6f)
    }

    // ── 方向自证: 与内置矩阵的索引语义完全一致 ────────────────────────────────
    //
    // 内置 createForConstantPower(4,2) 源码注释是 left = 1.0*FL + 0.7071*BL。
    // 实测回读 getMixingCoefficient(0,0)=1.0 / (1,0)=0.7071 —— 说明索引 0 是 FL、
    // 索引 1 是它的"左声道第二个来源"。本测试把这个语义固定住: 我们的矩阵必须
    // 同样是"第一个索引 = 输入声道"。
    @Test
    fun indexDirectionMatchesBuiltInMatrixSemantics() {
        val builtIn = ChannelMixingMatrix.createForConstantPower(4, 2)
        // 内置矩阵: 输入 0 只进 L, 输入 1 同时有 L 分量; 这只有"第一参数=输入"才成立。
        assertEquals(1.0f, builtIn.getMixingCoefficient(0, 0), 1e-4f)
        assertEquals(0f, builtIn.getMixingCoefficient(0, 1), 1e-4f)
        assertTrue(
            "内置矩阵在 (input=1, out=L) 上有非零系数, 说明第一参数是输入声道",
            builtIn.getMixingCoefficient(1, 0) > 0f,
        )

        // 我们的矩阵遵循同一方向: 输入 FL 只进 L
        val ours = QuadDownmix.buildQuadToStereoMatrix()
        assertTrue(ours.getMixingCoefficient(0, 0) > 0f)
        assertEquals(0f, ours.getMixingCoefficient(0, 1), 1e-6f)
    }

    // ── 后声道必须真的被混进来(核心回归) ──────────────────────────────────────
    //
    // 事故本质是「后声道被整个丢掉」。这条断言: 降混矩阵里 BL/BR 的系数必须 > 0,
    // 否则等于没修。
    @Test
    fun rearChannelsAreMixedInNotEmptyDropped() {
        assertTrue("BL→L 必须参与混音", QuadDownmix.BL_TO_L > 0f)
        assertTrue("BR→L 必须参与混音", QuadDownmix.BR_TO_L > 0f)
        assertTrue("BL→R 必须参与混音", QuadDownmix.BL_TO_R > 0f)
        assertTrue("BR→R 必须参与混音", QuadDownmix.BR_TO_R > 0f)

        val matrix = QuadDownmix.buildQuadToStereoMatrix()
        val rearIntoLeft = matrix.getMixingCoefficient(2, 0) + matrix.getMixingCoefficient(3, 0)
        val frontIntoLeft = matrix.getMixingCoefficient(0, 0)
        assertTrue("后声道贡献不应为零", rearIntoLeft > 0f)
        assertTrue("前声道贡献不应为零", frontIntoLeft > 0f)
        // 与"只取前声场"划清界限: 后声道贡献不得被压到无关紧要的量级。
        assertTrue(
            "后声道总系数($rearIntoLeft)相对前声道($frontIntoLeft)过小, 等于没把低频混回来",
            rearIntoLeft >= frontIntoLeft * 0.8f,
        )
    }

    // ── 恒等矩阵必须真的恒等, 否则普通立体声会被改动 ──────────────────────────
    @Test
    fun identityCoefficientsAreTrueIdentity() {
        for (channels in 1..8) {
            val matrix = ChannelMixingMatrix(channels, channels, QuadDownmix.identityCoefficients(channels))
            assertTrue("${channels}ch 恒等矩阵 isIdentity 应为 true", matrix.isIdentity())
        }
    }

    @Test
    fun stereoIdentityDoesNotAlterStereoInput() {
        val matrix = ChannelMixingMatrix(2, 2, QuadDownmix.identityStereoCoefficients())
        assertTrue(matrix.isIdentity())
        assertEquals(1f, matrix.getMixingCoefficient(0, 0), 1e-6f)
        assertEquals(0f, matrix.getMixingCoefficient(0, 1), 1e-6f)
        assertEquals(0f, matrix.getMixingCoefficient(1, 0), 1e-6f)
        assertEquals(1f, matrix.getMixingCoefficient(1, 1), 1e-6f)
    }

    // ── 注册的矩阵必须同时覆盖普通立体声与 quad ──────────────────────────────
    //
    // ChannelMixingAudioProcessor.onConfigure 在查不到当前声道数的矩阵时会**直接抛**
    // UnhandledAudioFormatException。只注册 4→2 会让库里 668 首立体声歌全部无法播放。
    //
    // 这条只能断言"要注册的矩阵清单", 不能真的 new 一个 ChannelMixingAudioProcessor:
    // 它内部用 android.util.SparseArray, 在 JVM 单测里会抛
    // RuntimeException("Method put in android.util.SparseArray not mocked")。
    @Test
    fun registeredMatricesCoverStereoWithIdentityAndQuadWithDownmix() {
        val matrices = QuadDownmix.matricesToRegister()
        val byInputChannels = matrices.groupBy { it.inputChannelCount }

        // 2 声道必须存在, 且最终生效的那条是恒等(不改变立体声)。
        val stereo = byInputChannels[2]?.lastOrNull()
        assertTrue("必须为 2 声道注册矩阵, 否则普通立体声歌无法播放", stereo != null)
        assertTrue("2 声道最终必须是恒等矩阵(不改变立体声)", stereo!!.isIdentity())

        // 1 声道(单声道源)同样要有, 且恒等。
        val mono = byInputChannels[1]?.lastOrNull()
        assertTrue("必须为 1 声道注册矩阵", mono != null)
        assertTrue("1 声道应为恒等", mono!!.isIdentity())

        // 4 声道必须存在, 且**不是**恒等 —— 否则等于没降混。
        val quad = byInputChannels[4]?.lastOrNull()
        assertTrue("必须为 4 声道注册矩阵", quad != null)
        assertTrue("4 声道必须真正降混(非恒等矩阵)", !quad!!.isIdentity())
        assertEquals(2, quad.outputChannelCount)

        // 3/5/6/7/8 声道等未知多声道源不能漏注册, 否则 onConfigure 直接抛异常。
        for (channels in listOf(3, 5, 6, 7, 8)) {
            assertTrue("$channels 声道也必须注册, 否则该格式播放会抛异常", byInputChannels[channels] != null)
        }
    }

    // ── 输出声道数必须是 2 ────────────────────────────────────────────────────
    @Test
    fun downmixOutputsExactlyStereo() {
        val quad = QuadDownmix.buildQuadToStereoMatrix()
        assertEquals(
            "手机只有 2 个物理输出声道, 降混结果必须是立体声",
            QuadDownmix.OUTPUT_CHANNEL_COUNT,
            quad.outputChannelCount,
        )
    }

    // ── 与内置系数划清界限 ────────────────────────────────────────────────────
    //
    // ChannelMixingMatrix.createForConstantPower(4, 2) 的系数和约 1.7071, 实测会让
    // 「千梦」「那三两句晚安」削顶到 0.0 dB。这条断言防止有人"简化"成用它。
    @Test
    fun doesNotReuseBuiltInConstantPowerMatrixBecauseItClips() {
        val builtIn = ChannelMixingMatrix.createForConstantPower(4, 2)
        val builtInColumnSum = (0 until 4)
            .sumOf { builtIn.getMixingCoefficient(it, 0).toDouble() }
            .toFloat()
        assertTrue(
            "内置 constant power 的系数和应当明显大于 1(这正是它削顶的原因), 实际 $builtInColumnSum",
            builtInColumnSum > 1.5f,
        )
        // 我们自己的矩阵必须比它保守。
        for (sum in QuadDownmix.rowSums()) {
            assertTrue("自建矩阵系数和 $sum 不应超过内置的 $builtInColumnSum", sum < builtInColumnSum)
        }
    }
}
