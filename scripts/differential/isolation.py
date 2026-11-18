#!/usr/bin/env python3
"""Disposable macOS Seatbelt execution. No original target is run by `verify`.

The profile is deny-default. Its only network grant is one loopback port.
An independent native canary must pass before callers may copy/run the target.
"""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import selectors
import signal
import socket
import subprocess
import tempfile
import threading
import time
import uuid

REPO = Path(__file__).resolve().parents[2]
TARGET_SHA256 = "e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837"
SYSTEM_READ = ["/System/Library", "/usr/lib", "/Library/Apple/System/Library"]
SYSTEM_PROGRAMS = ["/bin/sh", "/bin/bash", "/bin/cat", "/bin/ls", "/bin/pwd", "/usr/bin/env", "/usr/bin/git", "/usr/bin/uname"]


def sb_string(value: str) -> str:
    return json.dumps(value)


def clone_file(source, destination):
    """APFS copy-on-write clone, never a shared writable hard link."""
    source, destination = Path(source).resolve(), Path(destination)
    result = subprocess.run(["/bin/cp", "-c", str(source), str(destination)], capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError("APFS clone failed: " + result.stderr.decode("utf-8", "replace"))
    if os.path.samefile(source, destination):
        raise RuntimeError("Disposable copy unexpectedly shares its source inode")
    with source.open("rb") as file:
        original = hashlib.file_digest(file, "sha256").digest()
    with destination.open("rb") as file:
        copied = hashlib.file_digest(file, "sha256").digest()
    if original != copied:
        raise RuntimeError("Disposable APFS clone hash mismatch")
    return str(destination)


def profile(root: Path, port: int, tag: str, ancestor_metadata=True) -> str:
    read_paths = ["(literal \"/\")"] + [f"(subpath {sb_string(p)})" for p in SYSTEM_READ]
    read_paths += [f"(literal {sb_string(p)})" for p in SYSTEM_PROGRAMS + ["/usr/share/icu/icudt78l.dat", "/dev/null", "/dev/random", "/dev/urandom"]]
    read_paths += [f"(subpath {sb_string(str(root))})"]
    execute = [f"(subpath {sb_string(str(root))})"] + [f"(literal {sb_string(p)})" for p in SYSTEM_PROGRAMS]
    return "\n".join([
        "(version 1)", "(debug deny)", f"(deny default (with message {sb_string(tag)}))",
        "(allow file-read* file-map-executable " + " ".join(read_paths) + ")",
        '(allow file-read-metadata (literal "/private") (literal "/private/tmp"))' if ancestor_metadata else '',
        f"(allow file-write* (subpath {sb_string(str(root))}) (literal \"/dev/null\"))",
        "(allow process-exec " + " ".join(execute) + ")", "(allow process-fork)",
        "(allow signal (target self))", "(allow process-info* (target self))", "(allow sysctl-read)",
        f"(allow network-outbound (remote ip \"localhost:{port}\"))", "",
    ])


def child_environment(root: Path, port: int) -> dict[str, str]:
    # Deliberately construct, rather than filter, the environment. No inherited keys/proxies.
    return {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "SHELL": "/bin/sh", "LANG": "en_US.UTF-8", "TERM": "dumb",
        "HOME": str(root / "home"), "TMPDIR": str(root / "tmp"), "CLAUDE_CODE_TMPDIR": str(root / "tmp"), "CLAUDE_CONFIG_DIR": str(root / "config"),
        "XDG_CONFIG_HOME": str(root / "xdg-config"), "XDG_CACHE_HOME": str(root / "cache"), "XDG_DATA_HOME": str(root / "data"),
        "ANTHROPIC_API_KEY": "tau-disposable-dummy-key", "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1",
        "DISABLE_AUTOUPDATER": "1", "TAU_HOME": str(root / "tau-state"),
    }


def run_bounded(command: list[str], *, root: Path, env: dict[str, str], timeout: float = 20, max_output_bytes: int = 8 * 1024 * 1024) -> dict:
    started = time.monotonic()
    proc = subprocess.Popen(command, cwd=root / "work", env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    timed_out = False
    output_limited = False
    killed_group = False
    total = 0
    selector = selectors.DefaultSelector()
    for name in streams:
        selector.register(getattr(proc, name), selectors.EVENT_READ, name)
    def kill_group():
        nonlocal killed_group
        try:
            os.killpg(proc.pid, signal.SIGKILL)
            killed_group = True
        except ProcessLookupError: pass
    try:
        while selector.get_map() or proc.poll() is None:
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                timed_out = True; kill_group(); break
            for key, _events in selector.select(min(remaining, 0.2)):
                data = os.read(key.fd, 65536)
                if not data:
                    selector.unregister(key.fileobj); continue
                take = min(len(data), max(0, max_output_bytes - total))
                streams[key.data].extend(data[:take]); total += take
                if take < len(data):
                    output_limited = True; kill_group(); break
            if output_limited: break
        proc.wait(timeout=5)
    finally:
        # Even a normally exited launcher may have left daemon children with closed stdio.
        kill_group()
        selector.close()
        proc.stdout.close(); proc.stderr.close()
    return {"exit_code": proc.returncode, "timed_out": timed_out, "output_limited": output_limited,
            "remaining_process_group_killed": killed_group, "elapsed_seconds": round(time.monotonic()-started, 3),
            "stdout": streams["stdout"].decode("utf-8", "replace"), "stderr": streams["stderr"].decode("utf-8", "replace")}


class EmptyMock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", "0")))
        self.send_response(501); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(b'{"error":{"type":"api_error","message":"No scenario installed"}}')


class Isolation:
    def __init__(self, artifact_dir: Path, handler=EmptyMock, *, ancestor_metadata=True):
        headroom = shutil.disk_usage("/private/tmp").free
        if headroom < 1024 * 1024 * 1024:
            raise RuntimeError("Differential context requires at least 1 GiB free disk space; no context created")
        self.disk_headroom_at_start = headroom
        self.artifact_dir = artifact_dir.resolve()
        self.root = Path(tempfile.mkdtemp(prefix="tau-differential-", dir="/private/tmp")).resolve()
        self.tag = "TAU_DIFFERENTIAL_" + uuid.uuid4().hex
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        self.port = self.server.server_port
        self.env = child_environment(self.root, self.port)
        self.verified = False
        self.ancestor_metadata = ancestor_metadata
        self.report = {}
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        for name in ["work", "home", "tmp", "config", "cache", "data", "xdg-config", "bin", "tau-state"]:
            (self.root / name).mkdir(mode=0o700)
        self.sb_path = self.root / "profile.sb"
        self.sb_path.write_text(profile(self.root, self.port, self.tag, ancestor_metadata))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()

    def sandbox(self, command: list[str], timeout=20) -> dict:
        return run_bounded(["/usr/bin/sandbox-exec", "-f", str(self.sb_path), *command], root=self.root, env=self.env, timeout=timeout)

    def verify(self) -> dict:
        token = uuid.uuid4().hex
        host_guard = self.artifact_dir / ("host-guard-" + token)
        host_write = self.artifact_dir / ("forbidden-write-" + token)
        host_guard.write_text("independent canary; no personal data\n")
        alias = Path("/System/Volumes/Data" + str(host_guard))
        alias_same = alias.exists() and os.path.samefile(host_guard, alias)
        if not alias_same: raise RuntimeError("Cannot verify host Data-volume alias denial")
        (self.root / "work" / "allowed.txt").write_text("inside canary\n")
        binary = self.root / "bin" / "isolation-canary"
        compile_result = subprocess.run(["/usr/bin/clang", "-O2", "-Wall", "-Wextra", "-Wno-deprecated-declarations",
                                         str(REPO / "scripts/differential/isolation_canary.c"), "-o", str(binary)],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if compile_result.returncode: raise RuntimeError(compile_result.stderr.decode())
        excluded = socket.socket(); excluded.bind(("127.0.0.1", 0)); excluded.listen(2)
        excluded_port = excluded.getsockname()[1]
        control = socket.create_connection(("127.0.0.1", excluded_port), timeout=1); control.close()
        unix_path = self.root / "canary.sock"
        unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); unix.bind(str(unix_path)); unix.listen(2)
        control_unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); control_unix.connect(str(unix_path)); control_unix.close()
        try:
            result = self.sandbox([str(binary), str(self.root), str(host_guard), str(alias), str(host_write),
                                   str(self.port), str(excluded_port), str(unix_path), str(binary), "1" if self.ancestor_metadata else "0"])
            try: checks = json.loads(result["stdout"])
            except ValueError: checks = {}
            self.report = {"passed": result["exit_code"] == 0 and not result["timed_out"] and not host_write.exists(),
                           "checks": checks, "host_alias_control": alias_same, "other_loopback_positive_control": True,
                           "unix_positive_control": True, "profile": self.sb_path.read_text(), "canary": result,
                           "environment_keys": sorted(self.env), "root": str(self.root), "network_port": self.port, "tag": self.tag,
                           "disk_headroom_at_context_start": self.disk_headroom_at_start,
                           "original_executed": False}
            self.verified = self.report["passed"]
            (self.artifact_dir / "isolation.json").write_text(json.dumps(self.report, indent=2) + "\n")
            (self.artifact_dir / "profile.sb").write_text(self.sb_path.read_text())
            if not self.verified: raise RuntimeError("Isolation canaries failed; original execution forbidden")
            return self.report
        finally:
            excluded.close(); unix.close(); host_guard.unlink(missing_ok=True); host_write.unlink(missing_ok=True)

    def copy_target(self, target: Path) -> Path:
        if not self.verified: raise RuntimeError("Verify the live isolation context before copying the target")
        with target.open("rb") as file:
            digest = hashlib.file_digest(file, "sha256").hexdigest()
        if digest != TARGET_SHA256: raise RuntimeError("Installed target no longer matches pinned executable")
        destination = self.root / "bin" / "claude-original"
        clone_file(target, destination); destination.chmod(0o700)
        with destination.open("rb") as file:
            if hashlib.file_digest(file, "sha256").hexdigest() != digest: raise RuntimeError("Target copy hash mismatch")
        self.report["target_copy"] = {"method": "APFS cp -c", "distinct_inode": not os.path.samefile(target, destination), "sha256": digest}
        return destination

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
        shutil.rmtree(self.root)


@contextmanager
def verified_isolation(artifact_dir: Path, handler=EmptyMock, *, ancestor_metadata=True):
    isolation = Isolation(artifact_dir, handler, ancestor_metadata=ancestor_metadata)
    try:
        isolation.verify()
        yield isolation
    finally: isolation.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["verify"])
    parser.add_argument("--artifacts", type=Path, default=REPO / "artifacts/differential-pass")
    args = parser.parse_args()
    with verified_isolation(args.artifacts) as isolation:
        print(json.dumps({"passed": isolation.verified, "checks": isolation.report["checks"], "original_executed": False}))

if __name__ == "__main__": main()
