"""collection_common.strict_string / strict_integer 的等价性契约。

2026-11 全库扫描把 7 份重复的 `_string` 与 6 份 `_integer` 收敛到
collection_common,但**刻意不改语义** —— 它们与本模块原有的 string/integer
并不等价(见 collection_common 里那段说明)。

这条测试锁住"等价"这个前提:对一批真实形态的输入,strict_* 必须与原私有
实现的输出**逐字节相同**。如果将来有人把 strict_* 改成 string/integer 的实现
(看起来是"统一",实则改行为),这里会立刻红。

运行: python -m unittest tests.test_collection_common_strict -v
"""

from __future__ import annotations

import unittest

from provider_bridge.collection_common import strict_integer, strict_string


def _legacy_string(value):  # 还原各 provider 里那份私有实现
    if value is None or value == "NULL":
        return ""
    return str(value).strip()


def _legacy_integer(value):  # 还原各 provider 里那份私有实现
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


# 覆盖真实上游会出现的形态:None / 字符串 NULL / 空串 / 整数 / 浮点 /
# 数字字符串 / 负数 / 带空格 / 布尔 / 列表(退化输入)。
STRING_CASES = [
    None, "NULL", "", "  ", "abc", " abc ", "0", "200",
    0, 1, -5, 200,
    3.0, 3.5, -0.0, 1e20,
    True, False,
    [], {}, ["a"],
]

INTEGER_CASES = [
    None, "", "  ", 0, 1, -5, 200,
    3.0, 3.5, -0.0,
    "200", "3.5", "abc", "NULL",  # "3.5" 是 strict/宽松两套实现唯一的差异点
    True, False,
    [], {},
]


class StrictStringEquivalenceTest(unittest.TestCase):
    def test_matches_legacy_bit_for_bit(self):
        for value in STRING_CASES:
            with self.subTest(value=repr(value)):
                self.assertEqual(strict_string(value), _legacy_string(value))

    def test_float_is_not_normalized(self):
        """关键差异点:strict_string 不把 3.0 变成 "3"(那是 string() 的行为)。

        这条单独写,是因为"3.0 → 3"看起来更像"修好了",但它**改变了上游字段的
        字面值**,属于行为变更,不能在"去重"这个名义下顺手做。
        """
        self.assertEqual(strict_string(3.0), "3.0")
        self.assertEqual(strict_string(3.0), _legacy_string(3.0))


class StrictIntegerEquivalenceTest(unittest.TestCase):
    def test_matches_legacy_bit_for_bit(self):
        for value in INTEGER_CASES:
            with self.subTest(value=repr(value)):
                self.assertEqual(strict_integer(value), _legacy_integer(value))

    def test_float_string_is_rejected(self):
        """关键差异点(实测确认的唯一差异):strict_integer("3.5") == 0,
        而 integer("3.5") == 3。

        为什么会差:integer 先 float() 再 int(),能吃 "3.5";
        strict_integer 直接 int(),"3.5" 抛 ValueError 得 0。
        上游若把时长写成 "3.5"(字符串小数),两者给出不同结果 ——
        去重时保持原行为,不顺手放宽。

        注意 "200" 这种**整数字符串**两者都能吃(int("200") 是合法的),
        所以那不是差异点。本鱼最初把它写进断言,被这条测试当场纠正。
        """
        self.assertEqual(strict_integer("3.5"), 0)
        self.assertEqual(strict_integer("3.5"), _legacy_integer("3.5"))
        # 对照:整数字符串两者一致,不算差异
        self.assertEqual(strict_integer("200"), 200)


if __name__ == "__main__":
    unittest.main()
