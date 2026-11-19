#!/usr/bin/env python3
"""Copy reviewed public Bun and source/runtime data; never execute an entrypoint."""
import hashlib
import json
from pathlib import Path

from isolation import REPO,clone_file
from run_tau import digest

BUN_SOURCE=Path('/Users/josh-desktop/.local/share/mise/installs/bun/latest/bin/bun')
BUN_SHA256='0a2237cdcfa0d16ef501d9acca9f0026309ef348bea7393a64e8d1e3609565cc'


class SourceSnapshotDrift(RuntimeError):
    def __init__(self,message,evidence):
        super().__init__(message);self.evidence=evidence


def tree_hash(directory):
    return{str(p.relative_to(directory)):digest(p)for p in tree_files(directory)}


def bun_environment(root):
    values={'BUN_INSTALL':str(root/'bun-install'),'BUN_INSTALL_CACHE_DIR':str(root/'cache/bun/install'),'BUN_RUNTIME_TRANSPILER_CACHE_PATH':str(root/'cache/bun/transpiler')}
    for value in values.values():Path(value).mkdir(parents=True,exist_ok=True)
    return values


def copy_bun_executable(root):
    source=BUN_SOURCE.resolve(strict=True)
    if digest(source)!=BUN_SHA256:raise RuntimeError('Reviewed public Bun hash changed; preparation/entrypoint execution refused')
    destination=root/'bin/bun';clone_file(source,destination);destination.chmod(0o700)
    if digest(source)!=BUN_SHA256 or digest(destination)!=BUN_SHA256:raise RuntimeError('Copied public Bun differs')
    return destination,{'runtime':'bun','source_path':str(source),'bun_sha256':digest(destination),'source_sha256':digest(source),'copy_method':'APFS cp -c; distinct inode/full SHA256 verified'}


def tree_files(directory):
    paths=[]
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():raise RuntimeError('Unexpected runtime/source descendant symlink')
        if path.is_file():paths.append(path)
        elif not path.is_dir():raise RuntimeError('Unexpected special runtime/source file')
    if len(paths)>20000 or sum(p.stat().st_size for p in paths)>128*1024*1024:raise RuntimeError('Runtime/source tree exceeds preparation bound')
    return paths


def copy_bun_source_runtime(root,executable_manifest):
    destination=root/'tau';destination.mkdir();manifest_path=REPO/'package.json';manifest_before=digest(manifest_path);manifest=json.loads(manifest_path.read_text())
    if manifest.get('module')!='src/cli.ts':raise RuntimeError('Reviewed Bun entrypoint changed')
    source_root=REPO/'src';source_paths=tree_files(source_root);before={str(p.relative_to(REPO)):digest(p)for p in source_paths}
    clone_file(manifest_path,destination/'package.json');source_files={}
    for source in source_paths:
        relative=source.relative_to(REPO);copied=destination/relative;copied.parent.mkdir(parents=True,exist_ok=True);clone_file(source,copied);source_files[str(relative)]=digest(copied)
    if source_files!=before or {str(p.relative_to(REPO)):digest(p)for p in tree_files(source_root)}!=before or digest(manifest_path)!=manifest_before:raise RuntimeError('Source/package changed during source-copy snapshot')
    modules_root=(REPO/'node_modules').resolve();pending=list(manifest.get('dependencies',{}));packages={};package_files={};package_sources={}
    while pending:
        name=pending.pop()
        if name in packages:continue
        source=(REPO/'node_modules'/name).resolve(strict=True)
        if not source.is_relative_to(modules_root):raise RuntimeError('Runtime dependency leaves admitted node_modules')
        package_json=source/'package.json';data=json.loads(package_json.read_text());paths=tree_files(source);expected={str(p.relative_to(source)):digest(p)for p in paths};copied_root=destination/'node_modules'/name
        for path in paths:
            copied=copied_root/path.relative_to(source);copied.parent.mkdir(parents=True,exist_ok=True);clone_file(path,copied)
        actual={str(p.relative_to(copied_root)):digest(p)for p in tree_files(copied_root)}
        if actual!=expected or {str(p.relative_to(source)):digest(p)for p in tree_files(source)}!=expected:raise RuntimeError('Runtime dependency changed during snapshot')
        packages[name]=data.get('version');package_files[name]=actual;package_sources[name]=source;pending.extend(data.get('dependencies',{}))
        pending.extend(key for key in data.get('optionalDependencies',{})if(REPO/'node_modules'/key).exists())
    # The workspace may be edited concurrently. Re-read the ENTIRE admitted
    # snapshot after dependencies finish, without locking/changing live files.
    source_after={str(p.relative_to(REPO)):digest(p)for p in tree_files(source_root)}
    manifest_after=digest(manifest_path);package_after={name:tree_hash(path)for name,path in package_sources.items()}
    copied_source={str(p.relative_to(destination)):digest(p)for p in tree_files(destination/'src')}
    copied_package={name:tree_hash(destination/'node_modules'/name)for name in package_sources}
    resolved_after={name:str((REPO/'node_modules'/name).resolve(strict=True))for name in package_sources}
    consistency={'source_before':before,'source_after':source_after,'source_copied':copied_source,
                 'package_json_before':manifest_before,'package_json_after':manifest_after,'package_json_copied':digest(destination/'package.json'),
                 'dependency_hashes_before':package_files,'dependency_hashes_after':package_after,'dependency_hashes_copied':copied_package,
                 'dependency_paths_before':{name:str(path)for name,path in package_sources.items()},'dependency_paths_after':resolved_after}
    if before!=source_after or before!=copied_source or manifest_before!=manifest_after or manifest_before!=consistency['package_json_copied'] or package_files!=package_after or package_files!=copied_package or consistency['dependency_paths_before']!=resolved_after:
        raise SourceSnapshotDrift('Live source/package/runtime changed during final snapshot verification',consistency)
    result={**executable_manifest,'entrypoint':'src/cli.ts','source_files':source_files,'package_json_sha256':manifest_before,'packages':packages,'package_files':package_files,
            'snapshot_consistency':consistency,'source_snapshot':'All admitted src descendants conservatively copied; final complete before/after/copied hashes equal; no project test/bunfig/toolchain file copied or edited','no_autoinstall_argument':'--no-install','port_entrypoint_executed':False}
    result['manifest_sha256']=hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()
    return destination/'src/cli.ts',result
