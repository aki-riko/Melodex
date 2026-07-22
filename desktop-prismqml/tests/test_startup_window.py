# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest
from unittest.mock import Mock, call

import main


class StartupWindowTests(unittest.TestCase):
    def test_initial_window_is_explicitly_shown(self) -> None:
        window = Mock()

        main._show_initial_window(window)

        window.show.assert_called_once_with()
        window.showNormal.assert_not_called()
        window.requestActivate.assert_not_called()

    def test_tray_restore_recovers_paint_state_and_focus(self) -> None:
        window = Mock()

        main._restore_main_window(window)

        self.assertEqual(
            window.method_calls,
            [
                call.showNormal(),
                call.restoreVisibleState(),
                call.raise_(),
                call.requestActivate(),
            ],
        )


if __name__ == "__main__":
    unittest.main()
