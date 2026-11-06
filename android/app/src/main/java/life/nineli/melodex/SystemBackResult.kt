package life.nineli.melodex

/**
 * 返回键回调结果的判定。
 *
 * 为什么单独抽出来:插件的真实链路(addCallback → evaluateJavascript →
 * JS preventDefault)必须真机才能验,但**判定这一步**最容易写错 ——
 * evaluateJavascript 的结果是 JSON 编码字符串(形如 "\"handled\"")。
 * 若用 contains("handled") 这种朴素写法,"unhandled" 也会被判成已处理,
 * 结果就是返回键被静默吞掉、App 永远退不出去 —— 比原来的"直接退出"更糟。
 * 这里用精确匹配,并有 SystemBackResultTest 钉住。
 */
internal object SystemBackResult {
    /** Web 是否已消费这次返回键。 */
    fun isHandled(rawResult: String?): Boolean {
        val text = rawResult?.trim().orEmpty()
        if (text.isEmpty()) return false
        return text == "\"handled\"" || text == "handled"
    }
}
