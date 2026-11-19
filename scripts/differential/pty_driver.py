"""Drive one command under a pseudo-terminal with scripted keystrokes and screen waits.

The child gets the PTY slave as stdin/stdout/stderr and as its controlling
terminal, a fixed window size, and its own session. Output feeds a `vt.Screen`
whose replies to terminal queries are written back. Every step records the raw
byte range it produced and a screen snapshot.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import codecs
import fcntl
import os
import re
import select
import signal
import struct
import subprocess
import termios
import time

from vt import Screen

COLUMNS, ROWS = 100, 30
ANSI = re.compile(r"\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-Za-z]|[@-Z\\-_])")


def open_pty(columns: int = COLUMNS, rows: int = ROWS) -> tuple[int, int, str]:
    master, slave = os.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    return master, slave, os.ttyname(slave)


@dataclass
class Step:
    """One action. `send`/`screen` may be per-executable dicts keyed by executable name.

    `when` gates the step on the current screen. `screen` waits for a regex to newly
    appear (or, with `fresh=False`, merely be present) on the rendered screen; `quiet`
    then waits for that many seconds without output.
    """
    name: str
    send: str | dict | None = None
    screen: str | dict | None = None
    quiet: float = 0.4
    timeout: float = 15
    when: str | dict | None = None
    exit: bool = False
    fresh: bool = True


@dataclass
class StepRecord:
    name: str
    sent: str | None
    waited_for: str | None
    matched: bool | None
    skipped: bool
    elapsed_seconds: float
    raw_range: tuple[int, int]
    cursor: tuple[int, int]
    screen: str
    unanswered_queries: list[str] = field(default_factory=list)


def pick(value, executable):
    return value.get(executable) if isinstance(value, dict) else value


class PtySession:
    def __init__(self, command: list[str], *, env: dict[str, str], cwd: str, master: int, slave: int,
                 columns: int = COLUMNS, rows: int = ROWS, max_bytes: int = 16 * 1024 * 1024):
        self.master = master
        self.screen = Screen(columns, rows)
        self.raw = bytearray()
        self.max_bytes = max_bytes
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.last_output = time.monotonic()

        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave,
                                        close_fds=True, preexec_fn=controlling_terminal)
        os.close(slave)

    def pump(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            ready, _, _ = select.select([self.master], [], [], min(remaining, 0.05))
            if not ready:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:
                data = b""
            if not data:
                time.sleep(min(remaining, 0.05))
                return
            self.last_output = time.monotonic()
            self.raw.extend(data[: max(0, self.max_bytes - len(self.raw))])
            self.screen.feed(self.decoder.decode(data))
            for reply in self.screen.replies:
                os.write(self.master, reply.encode())
            self.screen.replies.clear()

    def wait_screen(self, pattern: str, timeout: float, since: int, baseline: int) -> bool:
        """True once `pattern` appears more often on screen than `baseline`, or in output after byte `since`."""
        compiled = re.compile(pattern, re.M)
        deadline = time.monotonic() + timeout

        def seen():
            stream = ANSI.sub("", bytes(self.raw[since:]).decode("utf-8", "replace"))
            return len(compiled.findall(self.screen.text())) > baseline or bool(compiled.search(stream))
        while time.monotonic() < deadline:
            if seen():
                return True
            if self.process.poll() is not None:
                self.pump(0.1)
                return seen()
            self.pump(0.1)
        return False

    def wait_quiet(self, quiet: float, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and time.monotonic() - self.last_output < quiet:
            self.pump(0.05)

    def wait_exit(self, timeout: float) -> int | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and self.process.poll() is None:
            self.pump(0.1)
        self.pump(0.1)
        return self.process.poll()

    def send(self, keys: str) -> None:
        # Typed text and its terminating key arrive as separate writes, as from a person.
        for chunk in re.split(r"(\r|\x1b\[[A-Z]|\x1b|\x03|\x04|\t)", keys):
            if chunk and self.process.poll() is None:
                os.write(self.master, chunk.encode())
                self.pump(0.15)

    def run(self, steps: list[Step], executable: str) -> list[StepRecord]:
        records = []
        for step in steps:
            started, start = time.monotonic(), len(self.raw)
            when = pick(step.when, executable)
            exited = self.process.poll() is not None
            skipped = exited or (when is not None and not re.search(when, self.screen.text(), re.M))
            keys, pattern, matched = pick(step.send, executable), pick(step.screen, executable), None
            baseline = len(re.findall(pattern, self.screen.text(), re.M)) if pattern and step.fresh else 0
            if not skipped:
                if keys:
                    self.send(keys)
                if step.exit:
                    matched = self.wait_exit(step.timeout) is not None
                elif pattern:
                    matched = self.wait_screen(pattern, step.timeout, start, baseline)
                self.wait_quiet(step.quiet, min(step.timeout, 5))
            records.append(StepRecord(step.name, None if skipped else keys, pattern, matched, skipped,
                                      round(time.monotonic() - started, 3), (start, len(self.raw)),
                                      (self.screen.row, self.screen.column), self.screen.text(),
                                      list(self.screen.unanswered)))
            self.screen.unanswered.clear()
        return records

    def close(self) -> int | None:
        code = self.process.poll()
        try:
            os.killpg(self.process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        self.process.wait(timeout=5)
        os.close(self.master)
        return code
