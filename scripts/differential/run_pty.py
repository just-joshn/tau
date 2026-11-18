#!/usr/bin/env python3
"""Interactive differential: the original or tau under a 100x30 PTY in one verified profile.

The profile additionally grants the single PTY slave this run opened (and /dev/tty).
Live tty canaries prove that grant: the slave opens inside the profile while a
second, unrelated PTY slave stays denied.

`--unsandboxed` runs tau only (never the original) from the checkout with the host
Bun, in a disposable root with the same dummy environment, for environments that
cannot nest sandbox-exec. Artifacts: raw bytes, per-step screens, mock requests,
and the config/settings files each run left behind.
"""
import argparse
from dataclasses import asdict
import http.server
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading

from isolation import REPO, TARGET_SHA256, Isolation, child_environment
from mock_api import MODEL
from pty_driver import COLUMNS, ROWS, PtySession, open_pty
from scenarios_pty import OBSERVED_FILES, SCENARIOS, SETUPS, PtyMock, seed


class LocalRoot:
    """Isolation's directory layout, environment and loopback mock, without Seatbelt."""

    def __init__(self, handler):
        self.root = Path(tempfile.mkdtemp(prefix="tau-pty-")).resolve()
        for name in ["work", "home", "tmp", "config", "cache", "data", "xdg-config", "bin", "tau-state"]:
            (self.root / name).mkdir(mode=0o700)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        self.env = child_environment(self.root, self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.report = {"sandboxed": False}

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        shutil.rmtree(self.root)


def tty_canaries(isolation, own, other):
    probe = 'exec 3<>"$0" && echo opened'
    results = {"own": isolation.sandbox(["/bin/sh", "-c", probe, own]), "other": isolation.sandbox(["/bin/sh", "-c", probe, other])}
    passed = results["own"]["stdout"].strip() == "opened" and results["other"]["exit_code"] != 0 and "opened" not in results["other"]["stdout"]
    isolation.report["tty_canaries"] = {"passed": passed, **results}
    if not passed:
        raise RuntimeError("PTY grant canaries failed; interactive execution forbidden")


def observed(root):
    files = {}
    for relative in OBSERVED_FILES:
        path = root / relative
        if path.is_file() and not path.is_symlink():
            files[relative] = path.read_text(errors="replace")[:65536]
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", choices=["original", "tau"])
    parser.add_argument("scenario", choices=sorted(SCENARIOS))
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass/pty")
    parser.add_argument("--setup", choices=SETUPS, default="onboarded", help="Dummy global config: see scenarios_pty.seed")
    parser.add_argument("--unsandboxed", action="store_true", help="tau only: host Bun and checkout source, no Seatbelt")
    args = parser.parse_args()
    if args.unsandboxed and args.executable != "tau":
        parser.error("--unsandboxed is for tau only; the original runs only inside the verified profile")
    directory = args.artifacts.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    stem = "-".join([args.executable, args.scenario, args.setup] + (["unsandboxed"] if args.unsandboxed else []))
    mock = PtyMock()
    master, slave, tty = open_pty()
    other_master, other_slave, other_tty = open_pty()
    # The positive canary opens a granted PTY of its own: a sandboxed session leader that opens the
    # session PTY would make it its controlling terminal, and macOS revokes that terminal when it exits.
    probe_master, probe_slave, probe_tty = open_pty()
    context = LocalRoot(mock.handler()) if args.unsandboxed else Isolation(directory, mock.handler(), tty_paths=[tty, probe_tty, "/dev/tty"])
    session = None
    try:
        runtime = {}
        if args.unsandboxed:
            command = [shutil.which("bun"), "--no-install", str(REPO / "src/cli.ts")]
        else:
            from bun_runtime import bun_environment
            from run_child_workflows import prepare_bun_adapter
            from run_original import PINNED_TARGET
            if args.executable == "tau":
                context.env.update(bun_environment(context.root))
            context.verify()
            tty_canaries(context, probe_tty, other_tty)
            if args.executable == "original":
                command = [str(context.copy_target(PINNED_TARGET))]
                runtime = {"target_sha256": TARGET_SHA256}
            else:
                bun, entry, runtime, _ = prepare_bun_adapter(context, directory, stem)
                command = [str(bun), "--no-install", str(entry)]
            command = ["/usr/bin/sandbox-exec", "-f", str(context.sb_path), *command]
        os.close(other_slave); os.close(other_master); os.close(probe_slave); os.close(probe_master)
        mock.work = context.root / "work"
        seed(context.root, context.env["ANTHROPIC_API_KEY"], args.setup)
        env = {**context.env, "TERM": "xterm-256color"}
        arguments = ["--model", MODEL]
        session = PtySession([*command, *arguments], env=env, cwd=str(context.root / "work"), master=master, slave=slave)
        steps = session.run(SCENARIOS[args.scenario](), args.executable)
        raw = bytes(session.raw)
        exit_code = session.close()
        session = None
        (directory / (stem + ".raw.bin")).write_bytes(raw)
        record = {"executable": args.executable, "scenario": args.scenario, "setup": args.setup, "size": [COLUMNS, ROWS],
                  "arguments": arguments, "isolation": context.report, "runtime": runtime, "exit_code": exit_code,
                  "steps": [asdict(step) for step in steps], "requests": mock.requests, "files": observed(context.root),
                  "original_executed": args.executable == "original"}
        (directory / (stem + ".json")).write_text(json.dumps(record, indent=2) + "\n")
        (directory / (stem + ".screens.txt")).write_text("".join(
            f"=== {s.name} sent={s.sent!r} wait={s.waited_for!r} matched={s.matched} skipped={s.skipped} cursor={s.cursor}\n{s.screen}\n\n"
            for s in steps))
        print(json.dumps({"stem": stem, "exit_code": exit_code, "steps": {s.name: s.matched for s in steps if not s.skipped},
                          "requests": len(mock.requests), "files": sorted(record["files"])}, indent=2))
    finally:
        if session is not None:
            session.close()
        context.close()


if __name__ == "__main__":
    main()
