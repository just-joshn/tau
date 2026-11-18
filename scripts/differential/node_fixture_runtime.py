#!/usr/bin/env python3
"""Copy the public Node executable for authored fixtures; no port/dependency copy."""
from pathlib import Path
import shutil
from isolation import clone_file
from run_tau import digest


def copy_node_fixture_runtime(root):
    location=shutil.which('node')
    if location is None:raise RuntimeError('Public Node runtime unavailable')
    source=Path(location).resolve();destination=root/'bin/node';clone_file(source,destination);destination.chmod(0o700)
    before=digest(source);after=digest(destination)
    if before!=after:raise RuntimeError('Copied public Node hash differs')
    return destination,{'purpose':'Authored command/mock fixtures only; no Tau entrypoint or project package/dependency read','copy_method':'APFS cp -c; distinct inode/full SHA256 verified','node_sha256':after,'source_sha256':before}
