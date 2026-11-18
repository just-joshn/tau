#!/usr/bin/env python3
"""Screen-model tests; no child process."""
import sys
import unittest

from pty_driver import PtySession, Step, open_pty
from vt import Screen


def screen(data, columns=20, rows=5):
    value = Screen(columns, rows)
    value.feed(data)
    return value


class ScreenModel(unittest.TestCase):
    def test_text_wraps_and_scrolls(self):
        value = screen("a" * 25 + "\r\nb\r\nc\r\nd\r\ne", columns=20, rows=5)
        self.assertEqual(value.text().splitlines(), ["a" * 5, "b", "c", "d", "e"])

    def test_pending_wrap_at_last_column_does_not_add_blank_line(self):
        value = screen("x" * 20 + "\r\ny")
        self.assertEqual(value.text().splitlines(), ["x" * 20, "y"])

    def test_ink_style_redraw_erases_previous_frame(self):
        frame = "> one\r\nfooter"
        value = screen(frame + "\x1b[2K\x1b[1A\x1b[2K\x1b[G> two\r\nfooter")
        self.assertEqual(value.text(), "> two\nfooter")

    def test_cursor_position_and_erase_display(self):
        value = screen("hello\r\nworld\x1b[1;3H\x1b[J")
        self.assertEqual(value.text(), "he")

    def test_erase_scrollback_keeps_visible_screen(self):
        self.assertEqual(screen("kept\x1b[3J").text(), "kept")

    def test_alternate_screen_restores_main(self):
        value = screen("main\x1b[?1049hfull\x1b[?1049l")
        self.assertEqual(value.text(), "main")

    def test_wide_characters_take_two_cells(self):
        value = screen("界a\x1b[1;4Hb", columns=10)
        self.assertEqual(value.text(), "界ab")

    def test_split_escape_sequences_are_buffered(self):
        value = Screen(20, 5)
        for part in ["ab\x1b", "[1", "D", "c"]:
            value.feed(part)
        self.assertEqual(value.text(), "ac")

    def test_sgr_osc_and_charset_are_ignored(self):
        value = screen("\x1b[1;31mred\x1b[0m\x1b]0;title\x07\x1b(B!")
        self.assertEqual(value.text(), "red!")

    def test_queries_produce_replies(self):
        value = screen("ab\x1b[6n\x1b[c\x1b]11;?\x07")
        self.assertEqual(value.replies, ["\x1b[1;3R", "\x1b[?62;22c", "\x1b]11;rgb:0000/0000/0000\x1b\\"])

    def test_delete_and_insert_characters(self):
        self.assertEqual(screen("abcdef\x1b[1;2H\x1b[2P").text(), "adef")
        self.assertEqual(screen("abc\x1b[1;2H\x1b[2@").text(), "a  bc")

    def test_scroll_region_limits_linefeed_scrolling(self):
        value = screen("top\x1b[2;4r\x1b[4;1Hx\r\ny\r\nz\x1b[5;1Hbottom", rows=5)
        self.assertEqual(value.text().splitlines(), ["top", "x", "y", "z", "bottom"])


class Driver(unittest.TestCase):
    def test_steps_wait_for_new_screen_text_and_exit(self):
        program = "import sys\nwhile True:\n    line = input('ask> ')\n    print('got ' + line)\n    if line == 'bye': break\n"
        master, slave, _ = open_pty()
        session = PtySession([sys.executable, "-c", program], env={"TERM": "xterm-256color"}, cwd="/", master=master, slave=slave)
        try:
            records = session.run([Step("ready", screen=r"ask> ", fresh=False), Step("typed", send="one", screen="one"),
                                   Step("answer", send="\r", screen=r"^ask> ", quiet=0.1), Step("skip", when="never", send="x"),
                                   Step("bye", send="bye\r", exit=True)], "any")
        finally:
            code = session.close()
        self.assertEqual([r.matched for r in records], [True, True, True, None, True])
        self.assertTrue(records[3].skipped)
        self.assertEqual(records[2].screen.splitlines()[:3], ["ask> one", "got one", "ask>"])
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
