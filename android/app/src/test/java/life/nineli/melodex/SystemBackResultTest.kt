package life.nineli.melodex

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 返回键回调结果的判定测试(实现见 main 里的 SystemBackResult)。
 *
 * 为什么要测这一步:插件真实链路(addCallback → evaluateJavascript →
 * JS preventDefault)必须真机才能验,但判定最容易写错 ——
 * evaluateJavascript 的结果是 JSON 编码字符串(形如 "\"handled\"")。
 * 用 contains("handled") 会把 "unhandled" 也判成已处理,
 * 结果返回键被静默吞掉、App 永远退不出去,比原来"直接退出"更糟。
 */
class SystemBackResultTest {

    @Test
    fun `handled 字符串被识别为已消费`() {
        assertTrue(SystemBackResult.isHandled("\"handled\""))
        assertTrue(SystemBackResult.isHandled("handled"))
    }

    @Test
    fun `unhandled 绝不能被误判成已消费`() {
        assertFalse(SystemBackResult.isHandled("\"unhandled\""))
        assertFalse(SystemBackResult.isHandled("unhandled"))
    }

    @Test
    fun `空值与异常文本一律按未消费处理`() {
        assertFalse(SystemBackResult.isHandled(null))
        assertFalse(SystemBackResult.isHandled(""))
        assertFalse(SystemBackResult.isHandled("   "))
        assertFalse(SystemBackResult.isHandled("null"))
    }

    @Test
    fun `带额外空白的正常返回仍能识别`() {
        assertTrue(SystemBackResult.isHandled("  \"handled\"  "))
        assertTrue(SystemBackResult.isHandled("\"handled\"\n"))
    }
}
