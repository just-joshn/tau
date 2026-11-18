"""Minimal VT/xterm screen model for PTY captures (no third-party dependency).

Covers what Ink and readline emit: printable text with wide characters, C0
controls, CSI cursor/erase/scroll/insert/delete, DEC private modes (alternate
screen, cursor visibility), save/restore cursor, and scroll regions. SGR, OSC,
DCS and charset selection are consumed without effect. Terminal queries the
child sends (cursor position, device attributes, colour) are answered through
`replies` so a driver can write them back, as a real terminal would.
"""
from __future__ import annotations

import re
import unicodedata

CSI = re.compile(r"\x1b\[([<=>?]?)([0-9;:]*)([ -/]*)([@-~])")


def char_width(char: str) -> int:
    if unicodedata.combining(char) or unicodedata.category(char) in ("Mn", "Me", "Cf"):
        return 0
    return 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1


class Screen:
    def __init__(self, columns: int = 100, rows: int = 30):
        self.columns, self.rows = columns, rows
        self.main = self._blank()
        self.alternate = None
        self.row = self.column = 0
        self.saved = (0, 0)
        self.top, self.bottom = 0, rows - 1
        self.cursor_visible = True
        self.pending_wrap = False
        self.replies: list[str] = []
        self.unanswered: list[str] = []
        self._tail = ""

    def _blank(self):
        return [[" "] * self.columns for _ in range(self.rows)]

    @property
    def grid(self):
        return self.alternate if self.alternate is not None else self.main

    def text(self) -> str:
        return "\n".join("".join(cell for cell in line if cell is not None).rstrip() for line in self.grid).rstrip("\n")

    def feed(self, data: str) -> None:
        data = self._tail + data
        self._tail = ""
        index = 0
        while index < len(data):
            char = data[index]
            if char == "\x1b":
                consumed = self._escape(data, index)
                if consumed is None:
                    self._tail = data[index:]
                    return
                index = consumed
                continue
            index += 1
            if char == "\r":
                self.column, self.pending_wrap = 0, False
            elif char in "\n\x0b\x0c":
                self._linefeed()
            elif char == "\b":
                self.column, self.pending_wrap = max(0, self.column - 1), False
            elif char == "\t":
                self.column = min(self.columns - 1, (self.column // 8 + 1) * 8)
            elif char == "\x07" or ord(char) < 0x20 or 0x7f <= ord(char) < 0xa0:
                continue
            else:
                self._put(char)

    def _put(self, char: str) -> None:
        width = char_width(char)
        if width == 0:
            return
        if self.pending_wrap or self.column + width > self.columns:
            self.column, self.pending_wrap = 0, False
            self._linefeed()
        line = self.grid[self.row]
        line[self.column] = char
        if width == 2:
            line[self.column + 1] = None
        if self.column + width >= self.columns:
            self.column, self.pending_wrap = self.columns - 1, True
        else:
            self.column += width

    def _linefeed(self) -> None:
        self.pending_wrap = False
        if self.row == self.bottom:
            self._scroll_up(1)
        elif self.row < self.rows - 1:
            self.row += 1

    def _scroll_up(self, count: int) -> None:
        grid = self.grid
        for _ in range(count):
            del grid[self.top]
            grid.insert(self.bottom, [" "] * self.columns)

    def _scroll_down(self, count: int) -> None:
        grid = self.grid
        for _ in range(count):
            del grid[self.bottom]
            grid.insert(self.top, [" "] * self.columns)

    def _escape(self, data: str, index: int):
        """Applies one escape sequence; returns the next index, or None when incomplete."""
        if index + 1 >= len(data):
            return None
        kind = data[index + 1]
        if kind == "[":
            match = CSI.match(data, index)
            if match is None:
                return None if re.fullmatch(r"\x1b\[[<=>?]?[0-9;:]*[ -/]*", data[index:]) else index + 2
            self._csi(*match.groups())
            return match.end()
        if kind in "]PX^_":
            ends = [p for p in (data.find("\x07", index + 2), data.find("\x1b\\", index + 2)) if p >= 0]
            if not ends:
                return None
            end = min(ends)
            if kind == "]":
                self._osc(data[index + 2:end])
            return end + (1 if data[end] == "\x07" else 2)
        if kind in "()*+":
            return None if index + 2 >= len(data) else index + 3
        if kind == "7":
            self.saved = (self.row, self.column)
        elif kind == "8":
            self.row, self.column = self.saved
        elif kind == "D":
            self._linefeed()
        elif kind == "E":
            self.column = 0
            self._linefeed()
        elif kind == "M":
            if self.row == self.top:
                self._scroll_down(1)
            else:
                self.row = max(0, self.row - 1)
        elif kind == "c":
            self.__init__(self.columns, self.rows)
        return index + 2

    def _osc(self, body: str) -> None:
        code, _, value = body.partition(";")
        if value == "?" and code in ("10", "11"):
            colour = "ffff/ffff/ffff" if code == "10" else "0000/0000/0000"
            self.replies.append(f"\x1b]{code};rgb:{colour}\x1b\\")

    def _csi(self, private: str, params: str, _intermediate: str, final: str) -> None:
        values = [int(p) if p.isdigit() else 0 for p in params.replace(":", ";").split(";")] if params else []
        first = values[0] if values else 0
        count = max(1, first)
        if final != "m":
            self.pending_wrap = False
        if private == "?":
            if final in "hl":
                for mode in values:
                    self._dec_mode(mode, final == "h")
            elif final == "u":
                self.unanswered.append("CSI ?u")
            return
        if private:
            if final == "c" and private == ">":
                self.replies.append("\x1b[>0;0;0c")
            elif final != "m":
                self.unanswered.append(f"CSI {private}{params}{final}")
            return
        grid = self.grid
        if final == "A":
            self.row = max(self.top if self.row >= self.top else 0, self.row - count)
        elif final == "B":
            self.row = min(self.bottom if self.row <= self.bottom else self.rows - 1, self.row + count)
        elif final == "C":
            self.column = min(self.columns - 1, self.column + count)
        elif final == "D":
            self.column = max(0, self.column - count)
        elif final == "E":
            self.row, self.column = min(self.rows - 1, self.row + count), 0
        elif final == "F":
            self.row, self.column = max(0, self.row - count), 0
        elif final in "G`":
            self.column = min(self.columns - 1, count - 1)
        elif final == "d":
            self.row = min(self.rows - 1, count - 1)
        elif final in "Hf":
            row = values[0] if values else 1
            column = values[1] if len(values) > 1 else 1
            self.row = min(self.rows - 1, max(1, row) - 1)
            self.column = min(self.columns - 1, max(1, column) - 1)
        elif final == "J":
            if first == 0:
                grid[self.row][self.column:] = [" "] * (self.columns - self.column)
                for line in range(self.row + 1, self.rows):
                    grid[line] = [" "] * self.columns
            elif first == 1:
                grid[self.row][: self.column + 1] = [" "] * (self.column + 1)
                for line in range(self.row):
                    grid[line] = [" "] * self.columns
            elif first == 2:
                for line in range(self.rows):
                    grid[line] = [" "] * self.columns
        elif final == "K":
            line = grid[self.row]
            if first == 0:
                line[self.column:] = [" "] * (self.columns - self.column)
            elif first == 1:
                line[: self.column + 1] = [" "] * (self.column + 1)
            else:
                grid[self.row] = [" "] * self.columns
        elif final == "X":
            end = min(self.columns, self.column + count)
            grid[self.row][self.column:end] = [" "] * (end - self.column)
        elif final == "P":
            line = grid[self.row]
            del line[self.column:self.column + count]
            line.extend([" "] * (self.columns - len(line)))
        elif final == "@":
            line = grid[self.row]
            line[self.column:self.column] = [" "] * count
            del line[self.columns:]
        elif final in "LM" and self.top <= self.row <= self.bottom:
            for _ in range(count):
                if final == "L":
                    del grid[self.bottom]
                    grid.insert(self.row, [" "] * self.columns)
                else:
                    del grid[self.row]
                    grid.insert(self.bottom, [" "] * self.columns)
        elif final == "S":
            self._scroll_up(count)
        elif final == "T":
            self._scroll_down(count)
        elif final == "r":
            top = (values[0] if values and values[0] else 1) - 1
            bottom = (values[1] if len(values) > 1 and values[1] else self.rows) - 1
            if top < bottom:
                self.top, self.bottom = top, min(bottom, self.rows - 1)
                self.row = self.column = 0
        elif final == "s":
            self.saved = (self.row, self.column)
        elif final == "u":
            self.row, self.column = self.saved
        elif final == "n" and first == 6:
            self.replies.append(f"\x1b[{self.row + 1};{self.column + 1}R")
        elif final == "n" and first == 5:
            self.replies.append("\x1b[0n")
        elif final == "c" and first == 0:
            self.replies.append("\x1b[?62;22c")
        elif final == "t" and first == 18:
            self.replies.append(f"\x1b[8;{self.rows};{self.columns}t")

    def _dec_mode(self, mode: int, enabled: bool) -> None:
        if mode == 25:
            self.cursor_visible = enabled
        elif mode in (47, 1047, 1049):
            if enabled and self.alternate is None:
                if mode == 1049:
                    self.saved = (self.row, self.column)
                self.alternate = self._blank()
            elif not enabled and self.alternate is not None:
                self.alternate = None
                if mode == 1049:
                    self.row, self.column = self.saved
