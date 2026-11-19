import { posix, win32 } from "node:path";
interface Options {
  booleanShort: string;
  valuedShort: string;
  attachedShort?: string;
  booleanLong: ReadonlySet<string>;
  valuedLong: ReadonlySet<string>;
  attachedLong?: ReadonlySet<string>;
}
interface CopyMoveOption {
  name: string;
  value?: string | undefined;
  afterOperand: boolean;
}
interface GitOption {
  opt: string;
  value?: string | undefined;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing source argument invariant");
  return value;
}
export function createNativeBashSecurityArguments(
  platform: "macos" | "linux" | "windows",
  home: () => string,
) {
  const paths = platform === "windows" ? win32 : posix;
  const P = () => platform;
  const D = <T>(a: readonly T[]) => [...new Set(a)];
  const zkn = home;
  const qkn = (a: string) => paths.basename(a);
  const dR = (a: string) => paths.isAbsolute(a);
  const op = (a: string) =>
    a === "~" || a.startsWith("~/") ? home() + a.slice(1) : a;
  const nt = (a: string, b: string) => {
    const i = a.indexOf(b);
    return i === -1 ? a : a.slice(0, i);
  };
  const APr = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
  const PPr = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
    "--attr-source",
    "--shallow-file",
  ]);
  function ty(e: string[]): string[] {
    let n = [],
      r = !1,
      a = !1;
    for (let h of e)
      if (r || a) n.push(h);
      else if (h === "--") r = !0;
      else if (h === "-" || !h?.startsWith("-")) {
        n.push(h);
        a = !0;
      }
    return n;
  }

  function hx(e: Options) {
    let n = (r: string) => {
      if (r.startsWith("--")) {
        if (r.includes("=")) return "attached";
        if (e.booleanLong.has(r)) return "boolean";
        if (e.attachedLong?.has(r)) return "attached";
        return e.valuedLong.has(r) ? "valued" : "unknown";
      }
      if (/^-\d+$/.test(r)) return "attached";
      for (let a = 1; a < r.length; a++) {
        let h = required(r[a]);
        if (e.booleanShort.includes(h)) continue;
        if (e.attachedShort?.includes(h)) return "attached";
        if (!e.valuedShort.includes(h)) return "unknown";
        return a === r.length - 1 ? "valued" : "attached";
      }
      return "boolean";
    };
    return (r: string[]) => {
      let a = [],
        h = !1,
        y = !1,
        k = !0;
      for (let E = 0; E < r.length; E++) {
        let N = r[E];
        if (N === void 0 || N === null) continue;
        if (h || y) a.push(N);
        else if (N === "--") h = !0;
        else if (N !== "-" && N.startsWith("-")) {
          if (!k) continue;
          let V = n(N);
          if (V === "valued") E++;
          else if (V === "unknown") k = !1;
        } else {
          a.push(N);
          y = !0;
        }
      }
      return a;
    };
  }

  function Qit(
    e: string[],
    n: ReadonlySet<string>,
    r: string[] = [],
  ): string[] {
    let a = [],
      h = !1,
      y = !1,
      k = !1;
    for (let E = 0; E < e.length; E++) {
      let N = e[E];
      if (N === void 0 || N === null) continue;
      if (!y && !k && N === "--") {
        y = !0;
        continue;
      }
      if (!y && !k && N !== "-" && N.startsWith("-")) {
        let V = N.indexOf("="),
          oe = V >= 0 ? N.slice(0, V) : N;
        if (["-e", "--regexp", "-f", "--file"].includes(oe)) {
          if (((h = !0), oe === "-f" || oe === "--file")) {
            let re = V >= 0 ? N.slice(V + 1) : e[E + 1];
            if (re) a.push(re);
          }
        }
        if (
          /^-[a-zA-Z]*f$/.test(oe) &&
          oe !== "-f" &&
          V < 0 &&
          e[E + 1] !== void 0
        ) {
          {
            h = !0;
            a.push(required(e[E + 1]));
            E++;
          }
          continue;
        }
        if (
          ["--exclude-from", "--include-from", "--ignore-file"].includes(oe)
        ) {
          let re = V >= 0 ? N.slice(V + 1) : e[E + 1];
          if (re) a.push(re);
          if (V < 0) E++;
          continue;
        }
        if (V < 0) {
          let re = Jit(N, ["-f", "--file"]);
          if (re !== void 0) {
            {
              h = !0;
              a.push(re);
            }
            continue;
          }
          if (N.length > 2 && N.startsWith("-e")) {
            h = !0;
            continue;
          }
        }
        if (n.has(oe) && V < 0) E++;
        continue;
      }
      if (k && !y) {
        let V = Jit(N, ["-f", "--file"]);
        if (V !== void 0) a.push(V);
      }
      if (((k = !0), !h)) {
        h = !0;
        continue;
      }
      a.push(N);
    }
    return a.length > 0 ? a : r;
  }

  function Jit(e: string, n: readonly string[]): string | undefined {
    if (!e.startsWith("-")) return;
    let r = e.indexOf("=");
    if (r >= 0) {
      if (n.includes(e.slice(0, r))) return e.slice(r + 1);
      return;
    }
    for (let a of n)
      if (a.length === 2 && a[0] === "-" && e.startsWith(a) && e !== a)
        return e.slice(2);
    return;
  }

  function dSn(e: string[]): { index: number; options: GitOption[] } {
    let n: GitOption[] = [],
      r = 0;
    while (r < e.length && required(e[r]).startsWith("-")) {
      let a = required(e[r]);
      if ((r++, PPr.has(a) && r < e.length)) {
        n.push({ opt: a, value: e[r] });
        r++;
      } else n.push({ opt: a });
    }
    return { index: r, options: n };
  }

  function jkn(e: string, n: string): string {
    return e === "" ? n : `${e.replace(/\/+$/, "")}/${n}`;
  }

  function xPr(e: string[]): string[] {
    return e.filter((n) => !APr.has(n));
  }

  function UOe(e: string): boolean {
    return (
      e === "/dev/null" ||
      e === "/dev/stdin" ||
      e === "/dev/stdout" ||
      e === "/dev/stderr" ||
      e === "/dev/tty" ||
      /^\/dev\/fd\/\d+$/.test(e) ||
      /^\/proc\/self\/fd\/[0-2]$/.test(e)
    );
  }

  function wSn(e: string[]): CopyMoveOption[] {
    let n: CopyMoveOption[] = [],
      r = !1;
    for (let a = 0; a < e.length; a++) {
      let h = e[a] ?? "";
      if (h === "--") break;
      if (h.startsWith("--")) {
        let y = nt(h.slice(2), "="),
          k = h.includes("=") ? h.slice(h.indexOf("=") + 1) : void 0,
          E =
            y.length >= 2 && "suffix".startsWith(y)
              ? "S"
              : y !== "" && "target-directory".startsWith(y)
                ? "t"
                : y !== "" && "backup".startsWith(y)
                  ? "b"
                  : y;
        n.push({
          name: E,
          value: k ?? (E === "S" || E === "t" ? e[++a] : void 0),
          afterOperand: r,
        });
      } else if (h.startsWith("-") && h.length > 1)
        for (let y = 1; y < h.length; y++) {
          let k = h[y] ?? "";
          if (k === "t" || k === "S") {
            let E = h.slice(y + 1);
            if (
              (n.push({
                name: k,
                value: E !== "" ? E : e[++a],
                afterOperand: r,
              }),
              E.startsWith("="))
            )
              n.push({ name: k, value: E.slice(1), afterOperand: r });
            break;
          }
          n.push({ name: k, afterOperand: r });
        }
      else r = !0;
    }
    return n;
  }

  function fat(
    e: string,
    n: string[],
  ): { targetDirectoryGiven: boolean; attachedDestinations: string[] } {
    let r = !1,
      a = [];
    if (e === "cp" || e === "mv") {
      for (let h of n)
        if (h.startsWith("--")) {
          let y = nt(h.slice(2), "=");
          if (y !== "" && "target-directory".startsWith(y)) {
            if (((r = !0), h.includes("=")))
              a.push(h.slice(h.indexOf("=") + 1));
          }
        } else if (h.startsWith("-") && h.indexOf("t") > 0) {
          if (((r = !0), h.indexOf("t") < h.length - 1)) {
            let y = h.slice(h.indexOf("t") + 1);
            a.push(y, ...(y.startsWith("=") ? [y.slice(1)] : []));
          }
        }
    }
    return { targetDirectoryGiven: r, attachedDestinations: a };
  }

  function hat(e: string[], n: string[], r: string[]): string[] {
    return D([
      ...wSn(e).flatMap((a) => (a.name === "t" ? [a.value ?? ""] : [])),
      ...r,
      ...n.filter(
        (a, h) => !a.startsWith("-") && n[h + 1]?.startsWith("-") === !0,
      ),
      ...n.slice(-1),
    ]).filter(Boolean);
  }

  function yat(e: string[], n: string[]): string[] {
    let r = [];
    for (let a of n)
      for (let h of e) {
        let y = qkn(h);
        if (h !== a && y !== "." && y !== "..")
          r.push(`${a.replace(/[\\/]+$/, "")}/${y}`);
      }
    return r;
  }

  function TSn(e: string[], n: string[]): boolean {
    return (
      n.some((r) => {
        let a = qkn(r);
        return a === "." || a === ".." || (P() === "macos" && /[\\/]$/.test(r));
      }) || e.some((r) => r.startsWith("--no-t") || /^-[^-]*T/.test(r))
    );
  }

  function ESn(e: string[]): boolean {
    return e.some((n) => /^--(?:pa|b|su)/.test(n) || /^-[^-]*[bS]/.test(n));
  }

  function vSn(e: string[]): boolean {
    let n = !1;
    for (let r of e) {
      if (r === "--") return !n;
      if (!r.startsWith("-") || r === "-") n = !0;
      else if (n || (r.startsWith("--") ? /^--[ls]/.test(r) : /[ls]/.test(r)))
        return !1;
    }
    return !0;
  }

  function lSn(e: string, n: string[]): string[] {
    switch (e) {
      case "cp":
      case "mv":
        return n.length >= 2 ? n.slice(0, -1) : [];
      case "sed":
        return n;
      default:
        return [];
    }
  }

  var MPr = new Set([
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "-m",
    "--max-count",
    "--max-depth",
    "--threads",
  ]);

  var vOe = (e: string[]): string[] => {
    let n = new Set([
        "-F",
        "--field-separator",
        "-v",
        "--assign",
        "-e",
        "--source",
      ]),
      r = new Set(["-f", "--file", "-E", "--exec"]),
      a = [],
      h = !1,
      y = !1,
      k = !1;
    for (let E = 0; E < e.length; E++) {
      let N = e[E];
      if (N === void 0 || N === null) continue;
      if (!h && !k && N === "--") {
        h = !0;
        continue;
      }
      if (!h && !k && N !== "-" && N.startsWith("-")) {
        let V = N.indexOf("="),
          oe = V >= 0 ? N.slice(0, V) : N;
        if (n.has(oe)) {
          if (oe === "-e" || oe === "--source") y = !0;
          if (V < 0) E++;
          continue;
        }
        if (r.has(oe)) {
          if (((y = !0), V >= 0)) a.push(N.slice(V + 1));
          else {
            let re = e[E + 1];
            if (re !== void 0) {
              a.push(re);
              E++;
            }
          }
          continue;
        }
        continue;
      }
      if (k && !h) {
        let V = Jit(N, ["-f", "--file", "-E", "--exec"]);
        if (V !== void 0) a.push(V);
      }
      if (((k = !0), !y)) {
        y = !0;
        continue;
      }
      a.push(N);
    }
    return a;
  };

  var lit = (e: string[]): string[] => {
    let r = Qit(
      e,
      new Set([
        "-e",
        "--regexp",
        "-f",
        "--file",
        "--exclude",
        "--include",
        "--exclude-dir",
        "--include-dir",
        "-m",
        "--max-count",
        "-A",
        "--after-context",
        "-B",
        "--before-context",
        "-C",
        "--context",
      ]),
    );
    if (
      r.length === 0 &&
      e.some((a) => ["-r", "-R", "--recursive"].includes(a))
    )
      return ["."];
    return r;
  };

  const DF: Readonly<Record<string, "read" | "write" | "create" | undefined>> =
    {
      cd: "read",
      ls: "read",
      find: "read",
      mkdir: "create",
      touch: "create",
      rm: "write",
      rmdir: "write",
      mv: "write",
      cp: "write",
      cat: "read",
      head: "read",
      tail: "read",
      sort: "read",
      uniq: "read",
      wc: "read",
      cut: "read",
      paste: "read",
      column: "read",
      tr: "read",
      file: "read",
      stat: "read",
      diff: "read",
      awk: "read",
      gawk: "read",
      mawk: "read",
      nawk: "read",
      strings: "read",
      hexdump: "read",
      od: "read",
      base64: "read",
      nl: "read",
      tac: "read",
      man: "read",
      rev: "read",
      fold: "read",
      expand: "read",
      unexpand: "read",
      fmt: "read",
      comm: "read",
      cmp: "read",
      pr: "read",
      numfmt: "read",
      tsort: "read",
      grep: "read",
      egrep: "read",
      fgrep: "read",
      rg: "read",
      sed: "write",
      git: "read",
      jq: "read",
      sha256sum: "read",
      sha1sum: "read",
      md5sum: "read",
      tee: "write",
    };

  const OPr: Readonly<Record<string, string | undefined>> = {
    cd: "change directories to",
    ls: "list files in",
    find: "search files in",
    mkdir: "create directories in",
    touch: "create or modify files in",
    rm: "remove files from",
    rmdir: "remove directories from",
    mv: "move files to/from",
    cp: "copy files to/from",
    cat: "concatenate files from",
    head: "read the beginning of files from",
    tail: "read the end of files from",
    sort: "sort contents of files from",
    uniq: "filter duplicate lines from files in",
    wc: "count lines/words/bytes in files from",
    cut: "extract columns from files in",
    paste: "merge files from",
    column: "format files from",
    tr: "transform text from files in",
    file: "examine file types in",
    stat: "read file stats from",
    diff: "compare files from",
    awk: "process text from files in",
    gawk: "process text from files in",
    mawk: "process text from files in",
    nawk: "process text from files in",
    strings: "extract strings from files in",
    hexdump: "display hex dump of files from",
    od: "display octal dump of files from",
    base64: "encode/decode files from",
    nl: "number lines in files from",
    tac: "read files (reversed) from",
    man: "read manual page files from",
    rev: "read files (reversed lines) from",
    fold: "wrap lines of files from",
    expand: "convert tabs in files from",
    unexpand: "convert spaces in files from",
    fmt: "reformat files from",
    comm: "compare files from",
    cmp: "compare files from",
    pr: "paginate files from",
    numfmt: "reformat numbers in files from",
    tsort: "sort files from",
    grep: "search for patterns in files from",
    egrep: "search for patterns in files from",
    fgrep: "search for patterns in files from",
    rg: "search for patterns in files from",
    sed: "edit files in",
    git: "access files with git from",
    jq: "process JSON from files in",
    sha256sum: "compute SHA-256 checksums for files in",
    sha1sum: "compute SHA-1 checksums for files in",
    md5sum: "compute MD5 checksums for files in",
    tee: "write to files in",
  };

  const IPr: Partial<Record<string, (e: string[]) => boolean>> = {
    mv: (e) => !e.some((n) => n?.startsWith("-")),
    cp: (e) => !e.some((n) => n?.startsWith("-")),
    cd: (e) => {
      let n = !1,
        r = 0;
      for (let a of e) {
        if (!n) {
          if (a === "--") {
            n = !0;
            continue;
          }
          if (a.startsWith("-") && a !== "-") continue;
          n = !0;
        }
        r++;
      }
      return r <= 1;
    },
  };

  const aM: Readonly<Record<string, ((e: string[]) => string[]) | undefined>> =
    {
      cd: (e) => {
        let n = ty(e);
        if (n.length === 0) return e.at(-1) === "-" ? ["-"] : [zkn()];
        return [required(n[0])];
      },
      ls: (e) => {
        let n = ty(e);
        return n.length > 0 ? n : ["."];
      },
      find: (e) => {
        let n = [],
          r = new Set([
            "-newer",
            "-anewer",
            "-cnewer",
            "-mnewer",
            "-samefile",
            "-path",
            "-wholename",
            "-ilname",
            "-lname",
            "-ipath",
            "-iwholename",
          ]),
          a = /^-newer[acmBt][acmtB]$/,
          h = !1,
          y = !1;
        for (let k = 0; k < e.length; k++) {
          let E = e[k];
          if (!E) continue;
          if (y) {
            n.push(E);
            continue;
          }
          if (E === "--") {
            y = !0;
            continue;
          }
          if (E.startsWith("-")) {
            if (["-H", "-L", "-P"].includes(E)) continue;
            if (((h = !0), r.has(E) || a.test(E))) {
              let N = e[k + 1];
              if (N) {
                n.push(N);
                k++;
              }
            }
            continue;
          }
          if (!h) n.push(E);
        }
        return n.length > 0 ? n : ["."];
      },
      mkdir: ty,
      touch: ty,
      rm: ty,
      rmdir: ty,
      mv: ty,
      cp: ty,
      cat: ty,
      head: ty,
      tail: ty,
      sort: ty,
      uniq: ty,
      wc: ty,
      cut: hx({
        booleanShort: "nswz",
        valuedShort: "bcdf",
        booleanLong: new Set([
          "--complement",
          "--only-delimited",
          "--zero-terminated",
        ]),
        valuedLong: new Set([
          "--bytes",
          "--characters",
          "--delimiter",
          "--fields",
          "--output-delimiter",
        ]),
      }),
      paste: hx({
        booleanShort: "sz",
        valuedShort: "d",
        booleanLong: new Set(["--serial", "--zero-terminated"]),
        valuedLong: new Set(["--delimiters"]),
      }),
      column: hx({
        booleanShort: "txdemLJhV",
        valuedShort: "cosNOClEHRTWrip",
        booleanLong: new Set([
          "--table",
          "--fillrows",
          "--table-noheadings",
          "--table-header-repeat",
          "--table-maxout",
          "--keep-empty-lines",
          "--json",
        ]),
        valuedLong: new Set([
          "--separator",
          "--output-separator",
          "--output-width",
          "--table-name",
          "--table-order",
          "--table-column",
          "--table-columns",
          "--table-columns-limit",
          "--table-noextreme",
          "--table-hide",
          "--table-right",
          "--table-truncate",
          "--table-wrap",
          "--tree",
          "--tree-id",
          "--tree-parent",
        ]),
      }),
      file: ty,
      stat: ty,
      diff: ty,
      awk: vOe,
      gawk: vOe,
      mawk: vOe,
      nawk: vOe,
      strings: ty,
      hexdump: ty,
      od: ty,
      base64: ty,
      nl: ty,
      sha256sum: ty,
      sha1sum: ty,
      md5sum: ty,
      tee: (e) => xPr(ty(e)),
      tr: (e) => {
        let n = e.some(
          (a) =>
            a === "-d" ||
            a === "--delete" ||
            (a.startsWith("-") && a.includes("d")),
        );
        return ty(e).slice(n ? 1 : 2);
      },
      grep: lit,
      egrep: lit,
      fgrep: lit,
      tac: hx({
        booleanShort: "br",
        valuedShort: "s",
        booleanLong: new Set(["--before", "--regex"]),
        valuedLong: new Set(["--separator"]),
      }),
      rev: ty,
      fold: hx({
        booleanShort: "bs",
        valuedShort: "w",
        booleanLong: new Set(["--bytes", "--spaces"]),
        valuedLong: new Set(["--width"]),
      }),
      expand: hx({
        booleanShort: "i",
        valuedShort: "t",
        booleanLong: new Set(["--initial"]),
        valuedLong: new Set(["--tabs"]),
      }),
      unexpand: hx({
        booleanShort: "af",
        valuedShort: "t",
        booleanLong: new Set(["--all", "--first-only"]),
        valuedLong: new Set(["--tabs"]),
      }),
      fmt: hx({
        booleanShort: "csumn",
        valuedShort: "wgdl",
        booleanLong: new Set([
          "--crown-margin",
          "--split-only",
          "--tagged-paragraph",
          "--uniform-spacing",
        ]),
        valuedLong: new Set(["--width", "--goal", "--prefix"]),
      }),
      comm: hx({
        booleanShort: "123iz",
        valuedShort: "",
        booleanLong: new Set([
          "--check-order",
          "--nocheck-order",
          "--total",
          "--zero-terminated",
        ]),
        valuedLong: new Set(["--output-delimiter"]),
      }),
      cmp: hx({
        booleanShort: "blsvxzh",
        valuedShort: "",
        booleanLong: new Set([
          "--print-bytes",
          "--verbose",
          "--quiet",
          "--silent",
        ]),
        valuedLong: new Set(["--ignore-initial", "--bytes"]),
      }),
      pr: hx({
        booleanShort: "acdFfJmprtTv",
        attachedShort: "einsS",
        valuedShort: "hlwWoND",
        booleanLong: new Set([
          "--across",
          "--show-control-chars",
          "--double-space",
          "--form-feed",
          "--join-lines",
          "--merge",
          "--no-file-warnings",
          "--omit-header",
          "--omit-pagination",
          "--show-nonprinting",
        ]),
        attachedLong: new Set([
          "--expand-tabs",
          "--output-tabs",
          "--number-lines",
          "--separator",
          "--sep-string",
        ]),
        valuedLong: new Set([
          "--header",
          "--length",
          "--width",
          "--page-width",
          "--indent",
          "--first-line-number",
          "--date-format",
          "--columns",
        ]),
      }),
      numfmt: hx({
        booleanShort: "z",
        valuedShort: "d",
        booleanLong: new Set(["--grouping", "--zero-terminated", "--debug"]),
        attachedLong: new Set(["--header"]),
        valuedLong: new Set([
          "--from",
          "--to",
          "--from-unit",
          "--to-unit",
          "--format",
          "--padding",
          "--delimiter",
          "--field",
          "--round",
          "--suffix",
          "--invalid",
        ]),
      }),
      tsort: ty,
      man: (e) => {
        let n = e.some(
          (r) => r === "--local-file" || (/^-[^-]/.test(r) && r.includes("l")),
        );
        return e.flatMap((r, a) => {
          if (a > 0 && (e[a - 1] === "-C" || e[a - 1] === "--config-file"))
            return [r];
          let h = r.search(/[\\/~]/);
          return (
            !r.startsWith("-")
              ? [r]
              : D([
                  ...(r.includes("=") ? [r.slice(r.indexOf("=") + 1)] : []),
                  ...(r.length > 2 && !r.startsWith("--") ? [r.slice(2)] : []),
                  ...(h > 0 ? [r.slice(h)] : []),
                ])
          ).filter(
            (k) =>
              k !== "" &&
              (n || /[\\/]/.test(k) || k.startsWith("~") || k.startsWith(".")),
          );
        });
      },
      rg: (e) =>
        Qit(
          e,
          new Set([
            "-e",
            "--regexp",
            "-f",
            "--file",
            "-t",
            "--type",
            "-T",
            "--type-not",
            "-g",
            "--glob",
            "-m",
            "--max-count",
            "--max-depth",
            "-r",
            "--replace",
            "-A",
            "--after-context",
            "-B",
            "--before-context",
            "-C",
            "--context",
          ]),
          ["."],
        ),
      sed: (e) => {
        let n = [],
          r = !1,
          a = !1,
          h = !1,
          y = !1;
        for (let k = 0; k < e.length; k++) {
          if (r) {
            r = !1;
            continue;
          }
          let E = e[k];
          if (!E) continue;
          if (!h && !y && E === "--") {
            h = !0;
            continue;
          }
          if (!h && !y && E !== "-" && E.startsWith("-")) {
            if (["-f", "--file"].includes(E)) {
              let N = e[k + 1];
              if (N) {
                n.push(N);
                r = !0;
              }
              a = !0;
            } else if (["-e", "--expression"].includes(E)) {
              r = !0;
              a = !0;
            } else if (E.includes("e") || E.includes("f")) a = !0;
            continue;
          }
          if (((y = !0), !a)) {
            a = !0;
            continue;
          }
          n.push(E);
        }
        return n;
      },
      jq: (e) => {
        let n = [],
          r = new Set([
            "-e",
            "--expression",
            "--arg",
            "--argjson",
            "--args",
            "--jsonargs",
            "-L",
            "--library-path",
            "--indent",
            "--tab",
          ]),
          a = !1,
          h = !1;
        for (let y = 0; y < e.length; y++) {
          let k = e[y];
          if (k === void 0 || k === null) continue;
          if (!h && k === "--") {
            h = !0;
            continue;
          }
          if (!h && k.startsWith("-")) {
            let E = k.indexOf("="),
              N = E >= 0 ? k.slice(0, E) : k;
            if (["-e", "--expression"].includes(N)) a = !0;
            if (["-f", "--from-file"].includes(N)) {
              if (((a = !0), E >= 0)) n.push(k.slice(E + 1));
              else {
                let V = e[y + 1];
                if (V !== void 0) {
                  n.push(V);
                  y++;
                }
              }
              continue;
            }
            if (["--slurpfile", "--rawfile"].includes(N)) {
              let V = e[y + 2];
              if (V !== void 0) n.push(V);
              y += 2;
              continue;
            }
            if (r.has(N) && E < 0) y++;
            continue;
          }
          if (!a) {
            a = !0;
            continue;
          }
          n.push(k);
        }
        return n;
      },
      git: (e) => {
        let n = "",
          r = (V: string) => {
            n = dR(op(V)) || V.startsWith("~") ? V : jkn(n, V);
          },
          { index: a, options: h } = dSn(e);
        for (let { opt: V, value: oe } of h)
          if (V.startsWith("--work-tree=")) r(V.slice(12));
          else if (oe !== void 0 && (V === "-C" || V === "--work-tree")) r(oe);
        let y = (V: string) =>
            n === "" || dR(op(V)) || V.startsWith("~") ? V : jkn(n, V),
          k = e.slice(a + 1);
        if (e[a] === "grep") {
          let V = Qit(k, MPr);
          return V.length > 0 ? V.map(y) : [n === "" ? "." : n];
        }
        if (e[a] !== "diff") return [];
        let E = [],
          N = !1;
        for (let V of k)
          if (!N && V === "--") N = !0;
          else if (N || V === "-" || !V.startsWith("-")) {
            let oe = y(V);
            if (!UOe(oe)) E.push(oe);
          }
        return E;
      },
    };

  return {
    extractors: aM,
    operations: DF,
    verbs: OPr,
    validators: IPr,
    native: {
      ty,
      hx,
      Qit,
      Jit,
      dSn,
      jkn,
      xPr,
      UOe,
      wSn,
      fat,
      hat,
      yat,
      TSn,
      ESn,
      vSn,
      lSn,
      vOe,
      lit,
      MPr,
      aM,
      DF,
      OPr,
      IPr,
    },
  };
}
