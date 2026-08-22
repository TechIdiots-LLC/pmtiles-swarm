#!/usr/bin/env python3
"""Why an archive re-checks instead of resuming.

Reads a node's real configuration, catalog, stored .torrent files and resume
directory, then works out — for every archive — what libtorrent will actually
do on the next start, and why. Nothing is started and nothing is written; the
service may be running or stopped.

Run it with the interpreter the sidecar uses, so it imports the same
libtorrent. It finds that interpreter from `libtorrent.python` in the config
and re-executes itself under it, so this is enough:

    sudo -u pmtiles-swarm python3 tools/resume-doctor.py \
        -c /etc/pmtiles-swarm/swarm.config.json

The three questions it answers, in the order they bite:

  1. Can the node write resume data at all before something kills it?
  2. Is the resume data on disk right, or is it a stale snapshot that will
     bring a complete archive back partial?
  3. What will each archive do on the next start — seed at once, stat its
     files, or re-hash the whole store?

Every rule it applies is libtorrent's own, cited to the file and line it was
read from, so a disagreement between this and reality is a bug in one of them
rather than a difference of opinion.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

# The re-exec guard. Without it, a config naming an interpreter that cannot
# import libtorrent would loop for ever.
REEXEC = "PMTILES_SWARM_DOCTOR_REEXEC"

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"
BOLD = "\033[1m"
OFF = "\033[0m"

OK, WARN, BAD, INFO = "ok", "warn", "bad", "info"
MARK = {OK: "OK ", WARN: "!  ", BAD: "X  ", INFO: "-  "}

# Every problem worth acting on, collected as it is found and ranked at the end.
findings = []


def plain():
    """Drops colour, for a pipe or NO_COLOR."""
    global GREEN, RED, YELLOW, DIM, BOLD, OFF
    GREEN = RED = YELLOW = DIM = BOLD = OFF = ""


def colour_for(level):
    return {OK: GREEN, WARN: YELLOW, BAD: RED, INFO: DIM}[level]


def note(level, headline, detail="", fix=""):
    """Records something for the summary, and prints it now.

    @param level: OK, WARN, BAD or INFO.
    @param headline: One line.
    @param detail: Why it matters.
    @param fix: What to do about it.
    """
    print(f"  {colour_for(level)}{MARK[level]}{OFF}{headline}")
    for line in detail.splitlines():
        if line.strip():
            print(f"      {DIM}{line}{OFF}")
        else:
            print()
    if level in (WARN, BAD):
        findings.append({"level": level, "headline": headline, "fix": fix})


def heading(text):
    print(f"\n{BOLD}-- {text} {'-' * max(0, 64 - len(text))}{OFF}")


def human(size):
    """Bytes, at a readable scale."""
    if size is None:
        return "?"
    value = float(size)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(value) < 1024 or unit == "TiB":
            return f"{int(value)} B" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TiB"


def ago(stamp):
    """How long ago a timestamp was, or '-' when there is none."""
    if not stamp:
        return "-"
    delta = time.time() - stamp
    for size, unit in ((86400, "d"), (3600, "h"), (60, "m")):
        if delta >= size:
            return f"{delta / size:.0f}{unit} ago"
    return f"{delta:.0f}s ago"


# ---- configuration --------------------------------------------------------


def load_config(path):
    """The config as the node resolves it.

    Every path resolves against the config file's own directory, which is what
    src/config.js does — a relative path under a unit file otherwise resolves
    against WorkingDirectory and lands somewhere nothing looks.

    @param path: Path to swarm.config.json.
    @return: The parsed config, with its paths made absolute.
    """
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)

    base = os.path.dirname(os.path.abspath(path))

    def against_base(value, fallback):
        return os.path.abspath(os.path.join(base, value or fallback))

    lt_conf = config.setdefault("libtorrent", {})
    # Kept, because watched folders resolve against it too and they are read
    # long after this function has returned.
    config["_base"] = base
    config["dataDir"] = against_base(config.get("dataDir"), "./data")
    config["savePath"] = against_base(
        config.get("savePath") or lt_conf.get("savePath"),
        "./data/torrents-data",
    )
    lt_conf["resumeDir"] = against_base(
        lt_conf.get("resumeDir"), os.path.join(config["dataDir"], "resume")
    )
    return config


def reexec_under_sidecar_python(config, argv):
    """Re-runs this script under the interpreter the sidecar uses.

    Diagnosing resume data with a different libtorrent than the one that wrote
    it is diagnosing a different program. A venv named in `libtorrent.python`
    is exactly the case that goes wrong silently.

    @param config: The loaded config.
    @param argv: This process's argv.
    """
    if os.environ.get(REEXEC):
        return
    wanted = config.get("libtorrent", {}).get("python") or "python3"
    resolved = shutil.which(wanted) or wanted
    if not os.path.exists(resolved):
        return
    if os.path.realpath(resolved) == os.path.realpath(sys.executable):
        return
    os.environ[REEXEC] = "1"
    print(f"{DIM}re-running under {resolved} (libtorrent.python){OFF}")
    os.execv(resolved, [resolved, os.path.abspath(argv[0])] + argv[1:])


# ---- libtorrent's own rules, restated -------------------------------------


def libtorrent_version(lt):
    """What build this is, however the binding chooses to say so.

    `version` is bound by both the 1.2 and 2.x source, and some distribution
    builds ship without the version module bound at all — so asking for one
    name and trusting it crashes on exactly the machine worth diagnosing.

    Nothing here depends on the answer: 1.2 and 2.x both verify resume data by
    file size alone, with no mtime anywhere in either. It is reported because
    the reader wants it, not because a rule turns on it.

    @param lt: The libtorrent module.
    @return: A version string, or 'unknown'.
    """
    for name in ("version", "__version__"):
        value = getattr(lt, name, None)
        if isinstance(value, str) and value.strip():
            return value
    major = getattr(lt, "version_major", None)
    minor = getattr(lt, "version_minor", None)
    if major is not None:
        return f"{major}.{minor if minor is not None else 'x'}"
    return "unknown (this build binds no version)"


def v1_of(source):
    """The v1 infohash, which is the name everything else knows a torrent by.

    A hybrid torrent answers info_hash() with the truncated v2 hash, while
    resume files are named by the v1 one. Mirrors _v1_of in the sidecar.

    @param source: A torrent_info or add_torrent_params.
    @return: A hex string, or None.
    """
    holder = getattr(source, "info_hashes", None)
    if holder is not None:
        try:
            hashes = holder() if callable(holder) else holder
            has_v1 = getattr(hashes, "has_v1", True)
            if callable(has_v1):
                has_v1 = has_v1()
            if has_v1:
                value = str(hashes.v1)
                if value and value.strip("0"):
                    return value
        except Exception:  # noqa: BLE001 - binding differences across builds
            pass
    try:
        value = str(source.info_hash())
        return value if value.strip("0") else None
    except Exception:  # noqa: BLE001
        return None


def have_bits(atp):
    """have_pieces as a list of bools, across binding shapes.

    @param atp: An add_torrent_params.
    @return: A list of bools, empty when nothing was recorded.
    """
    raw = getattr(atp, "have_pieces", None)
    if raw is None:
        return []
    try:
        return [bool(bit) for bit in raw]
    except TypeError:
        size = raw.size() if callable(getattr(raw, "size", None)) else len(raw)
        return [bool(raw.get_bit(index)) for index in range(size)]


def seed_mode_survives(seed_only, bits, priorities):
    """Whether libtorrent will honour the seed_mode claim.

    torrent.cpp:408 drops seed_mode, silently, if the resume data holds a
    single unset piece or any file at priority zero. This is the whole reason a
    stale resume file is worse than no resume file: without one the claim
    stands and the archive seeds at once; with a half-filled one the claim is
    discarded and the archive comes back partial.

    @param seed_only: Whether the node claims the data is all here.
    @param bits: have_pieces from the resume data.
    @param priorities: file_priorities from the resume data.
    @return: True when the torrent starts as a seed.
    """
    if not seed_only:
        return False
    if any(priority == 0 for priority in priorities):
        return False
    return not any(bit is False for bit in bits)


def is_pad_file(files, index):
    """Whether a file is padding, across binding versions.

    2.1's bindings expose file_storage.pad_file_at(); 2.0's do not, and the
    same question there is a bit in file_flags(). A build answering neither is
    treated as having no padding, which is true of every torrent this node cuts.

    @param files: A file_storage.
    @param index: The file index.
    @return: True when the file is a pad file.
    """
    direct = getattr(files, "pad_file_at", None)
    if direct is not None:
        return bool(direct(index))
    flags = getattr(files, "file_flags", None)
    pad = getattr(files, "flag_pad_file", None)
    if flags is not None and pad is not None:
        return bool(flags(index) & pad)
    return False


def file_piece_range(offset, size, piece_length):
    """The pieces a file touches, end exclusive. file_storage.cpp:1785."""
    if size <= 0:
        return (0, 0)
    return (offset // piece_length, (offset + size - 1) // piece_length + 1)


def can_read(path):
    """Whether this account can actually read the bytes, not just stat them.

    Worth asking separately because the two are different permissions and only
    one of them is what hashing needs. `os.path.getsize` succeeds with nothing
    but traverse on the directory, so a file the service cannot open reads as
    present and correctly sized right up until libtorrent tries to hash it —
    at which point every piece fails and the check completes having found
    nothing. That is a full-length, all-false bitfield: an archive at 0% with
    the whole file on the disk beside it.

    @param path: The file to try.
    @return: (readable, reason) — reason empty when it opened.
    """
    try:
        with open(path, "rb") as handle:
            handle.read(1)
        return True, ""
    except OSError as error:
        return False, f"{error.strerror or error}"


def sample_pieces(ti, save_path, bits, count=3):
    """Hashes a few real pieces, to settle what a size check cannot.

    Everything else here reasons from file *size*, which is all libtorrent's own
    verify_resume_data looks at — and a file of the right length holding
    different bytes passes that test while failing every hash. The two look
    identical from outside and mean opposite things: one is an archive whose
    resume data has gone stale and wants its file deleted, the other is a
    download legitimately in progress against a file that is genuinely not this
    torrent's. Guessing between them is how a real download gets called a bug.

    Pieces the resume data claims are *missing* are preferred, because those are
    the ones in dispute. Only single-file torrents are sampled; the archives
    this node distributes are all one file, and mapping a piece across a
    multi-file layout is not worth doing on a guess.

    @param ti: The torrent_info.
    @param save_path: Where the data should be.
    @param bits: have_pieces from the resume data.
    @param count: How many pieces to hash.
    @return: (checked, passed, note) — checked 0 when it could not sample.
    """
    files = ti.files()
    if files.num_files() != 1:
        return 0, 0, "multi-file torrent, not sampled"

    path = os.path.join(save_path, files.file_path(0))
    total = ti.num_pieces()

    # The disputed pieces first, then a spread across the file, so a torrent
    # whose resume data claims everything still gets looked at.
    disputed = [i for i in range(len(bits)) if not bits[i]][:count]
    spread = [0, total // 2, total - 1]
    wanted = list(dict.fromkeys(disputed + spread))[:count]

    checked = passed = 0
    try:
        with open(path, "rb") as handle:
            for index in wanted:
                if index < 0 or index >= total:
                    continue
                handle.seek(index * ti.piece_length())
                data = handle.read(ti.piece_size(index))
                if len(data) < ti.piece_size(index):
                    continue
                checked += 1
                if hashlib.sha1(data).digest() == bytes(ti.hash_for_piece(index)):
                    passed += 1
    except OSError as error:
        return checked, passed, f"read failed: {error.strerror or error}"

    return checked, passed, ""


def predict_check(ti, bits, priorities, seed_flag, save_path):
    """What async_check_files will conclude. storage_utils.cpp:328.

    Resume data carries no mtimes on either the 1.2 or the 2.x branch, so
    nothing here depends on a timestamp — only on file sizes, and on which
    files a completed piece touches. A file shorter than the torrent says is
    `mismatching_file_size`, and that costs a full re-hash of the store.

    Readability is checked beyond what libtorrent's own function does, because
    a file it cannot open fails later and far less legibly.

    @param ti: The torrent_info.
    @param bits: have_pieces from the resume data.
    @param priorities: file_priorities from the resume data.
    @param seed_flag: Whether the add carries torrent_flags::seed_mode.
    @param save_path: Where the data should be.
    @return: (verified, reason) — verified False means a full re-check.
    """
    files = ti.files()
    num_pieces = ti.num_pieces()
    piece_length = ti.piece_length()

    seed = (len(bits) >= num_pieces and all(bits)) or seed_flag

    for index in range(files.num_files()):
        if is_pad_file(files, index):
            continue
        expected = files.file_size(index)
        priority_zero = index < len(priorities) and priorities[index] == 0
        path = os.path.join(save_path, files.file_path(index))

        if seed:
            # A priority-zero file may legitimately be in a partfile, unless
            # seed_mode says otherwise.
            if priority_zero and not seed_flag:
                continue
            actual = os.path.getsize(path) if os.path.exists(path) else -1
            if actual < 0:
                return False, f"{os.path.basename(path)} is not there"
            if actual < expected:
                return False, (
                    f"{os.path.basename(path)} is {human(actual)}, and the "
                    f"torrent says {human(expected)}"
                )
            readable, why = can_read(path)
            if not readable:
                return None, f"{os.path.basename(path)} cannot be opened ({why})"
            continue

        if priority_zero or expected == 0:
            continue

        start, end = file_piece_range(files.file_offset(index), expected, piece_length)
        end = min(end, len(bits))
        if not any(bits[piece] for piece in range(start, end)):
            continue
        if not os.path.exists(path):
            return False, f"{os.path.basename(path)} is not there"
        readable, why = can_read(path)
        if not readable:
            return None, f"{os.path.basename(path)} cannot be opened ({why})"

    return True, ""


# ---- the report -----------------------------------------------------------


def report_environment(config, lt, config_path):
    heading("environment")
    rows = (
        ("config", config_path),
        ("python", f"{sys.executable} ({sys.version.split()[0]})"),
        ("libtorrent", libtorrent_version(lt)),
        (
            "engine",
            " + ".join(
                [config.get("engine", "libtorrent")]
                + list(config.get("secondaryEngines") or [])
            ),
        ),
        ("dataDir", config["dataDir"]),
        ("resumeDir", config["libtorrent"]["resumeDir"]),
        (
            "savePath",
            f"{config['savePath']}   (layout: {config.get('savePathLayout', 'flat')})",
        ),
        ("resume interval", f"{config.get('resumeSaveIntervalSeconds', 300)}s"),
    )
    for label, value in rows:
        print(f"  {label:<17} {value}")

    if config.get("engine") != "libtorrent":
        note(
            INFO,
            f"the primary engine is {config.get('engine')}, not libtorrent",
            "Everything below reads libtorrent's resume directory, which that "
            "engine does not use.",
        )
    if config.get("incompleteSuffix"):
        note(
            INFO,
            f"incompleteSuffix is {config['incompleteSuffix']!r}, and the "
            "libtorrent engine ignores it",
            "marksIncomplete is false for this engine, so a partial archive "
            "sits under its final name from the first byte. Nothing to fix, "
            "but never point a web server at this save path.",
        )


def report_unit(config, torrent_count):
    """systemd's account of the unit, which is the only one worth trusting."""
    heading("the unit")
    if not shutil.which("systemctl"):
        note(INFO, "no systemctl here, so the unit cannot be read")
        return

    wanted = (
        "KillMode",
        "TimeoutStopUSec",
        "Restart",
        "ReadWritePaths",
        "MainPID",
        "ActiveState",
        "ExecMainStartTimestamp",
        "NRestarts",
    )
    try:
        raw = subprocess.run(
            ["systemctl", "show", "pmtiles-swarm", "-p", ",".join(wanted)],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
    except Exception as error:  # noqa: BLE001
        note(INFO, f"could not ask systemd: {error}")
        return

    props = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
    if not props:
        note(INFO, "systemd does not know a pmtiles-swarm unit")
        return

    kill_mode = props.get("KillMode", "")
    if kill_mode == "mixed":
        note(OK, "KillMode=mixed")
    else:
        note(
            BAD,
            f"KillMode={kill_mode or 'unset'}",
            "control-group sends SIGTERM to the node and the Python sidecar at "
            "the same instant. The node's shutdown then asks a sidecar that is "
            "already dying to write its resume data, into a pipe that is "
            "closing, and the answer never comes. Every archive returns at 0% "
            "and has to be re-checked to discover it was complete all along.",
            "Add KillMode=mixed to the unit, then systemctl daemon-reload.",
        )

    stop_usec = props.get("TimeoutStopUSec", "")
    stop_seconds = None
    match = re.match(r"(\d+)\s*(min|s|ms)", stop_usec.replace(" ", ""))
    if match:
        stop_seconds = int(match.group(1)) * {"min": 60, "s": 1, "ms": 0.001}[
            match.group(2)
        ]
    needed = max(15.0, torrent_count * 2.0 + 10.0) + 15.0
    if stop_seconds is not None and stop_seconds < needed:
        note(
            WARN,
            f"TimeoutStopSec is {stop_usec}, and this library needs about "
            f"{needed:.0f}s",
            "The node allows its engine step two seconds per torrent, and "
            "systemd has to outlast that. Anything still unwritten when its "
            "patience runs out is killed mid-write and re-hashed on the way "
            "back up.",
            f"Raise TimeoutStopSec to at least {needed:.0f}s.",
        )
    else:
        note(OK, f"TimeoutStopSec={stop_usec}")

    if props.get("Restart") == "always":
        note(OK, "Restart=always")
    else:
        note(
            WARN,
            f"Restart={props.get('Restart') or 'unset'}",
            "Save & Restart exits 0 and expects to be brought back; "
            "on-failure ignores an exit 0.",
            "Set Restart=always.",
        )

    paths = (props.get("ReadWritePaths") or "").strip()
    if paths:
        parts = [
            part
            for part in re.split(r"[\s,]+", paths.strip("[]"))
            if part.startswith("/")
        ]
        # Kept for the per-archive check: an archive may legitimately live
        # anywhere, and each of those places needs naming here too.
        config["_readWritePaths"] = parts
        for label, target in (
            ("resumeDir", config["libtorrent"]["resumeDir"]),
            ("dataDir", config["dataDir"]),
            ("savePath", config["savePath"]),
        ):
            covered = any(
                target == part or target.startswith(part.rstrip("/") + "/")
                for part in parts
            )
            if not covered:
                note(
                    BAD,
                    f"{label} {target} is not under ReadWritePaths",
                    "ProtectSystem=strict refuses the write inside the unit's "
                    "namespace, before any permission bit is consulted. A "
                    "directory whose group bits are perfect still fails.",
                    f"Add {target} to ReadWritePaths, then daemon-reload.",
                )
        note(INFO, f"ReadWritePaths={paths}")

    print(
        f"  {DIM}   state {props.get('ActiveState')}, pid {props.get('MainPID')}, "
        f"{props.get('NRestarts', '?')} restarts, up since "
        f"{props.get('ExecMainStartTimestamp') or '-'}{OFF}"
    )


def report_save_budgets(torrent_count):
    """Every bound that can cut a resume save short, and which one wins.

    All of them scale with the library now, because the sidecar's own budget
    does: it allows each torrent two seconds. The fixed values these replaced
    were the whole reason a node past a handful of archives lost resume data on
    every stop and re-hashed on the way back up.
    """
    heading("the save budgets")
    needed = max(5.0, 2.0 * torrent_count)
    # src/shutdown.js engineStopMs, restated. A disagreement between this and
    # that is the thing worth catching.
    allowed = max(15.0, torrent_count * 2.0 + 10.0)

    print(f"  the sidecar wants     {needed:>5.0f}s   max(5, 2 x {torrent_count}), op_save_resume")
    print(f"  the node allows       {allowed:>5.0f}s   engineStopMs, src/shutdown.js")
    print(f"  the watchdog          {'sum':>5}     derived from the steps, src/shutdown.js")

    if allowed < needed:
        note(
            BAD,
            f"the node allows {allowed:.0f}s and the sidecar wants {needed:.0f}s",
            "The node abandons the sidecar mid-write and exits, so only the "
            "torrents whose alerts arrived in time are persisted.",
            "engineStopMs has fallen behind op_save_resume's budget; they have "
            "to be changed together.",
        )
    else:
        note(OK, f"{allowed:.0f}s of node budget covers the sidecar's {needed:.0f}s")

    note(
        INFO,
        f"TimeoutStopSec must exceed about {allowed + 15:.0f}s for this library",
        "systemd's patience has to outlast the node's own bounds, or it kills "
        "the process while the save is still running — which is the same lost "
        "resume data by a different route. The unit check above compares them.",
    )


def report_gate():
    """Whether the gate meant to stop needless rewrites can ever say no."""
    heading("the need_save_resume_data gate")
    note(
        WARN,
        "the no-argument form is true for every running torrent",
        "The sidecar skips a save when need_save_resume_data() says nothing "
        "changed. The no-argument form asks about all five conditions, and one "
        "of them is if_counters_changed — which libtorrent's own header says a "
        "torrent that is not paused increments continuously "
        "(torrent_handle.hpp:713). So it answers yes every cycle, for every "
        "archive, and the gate skips nothing.\n"
        "Two costs: a hybrid archive's merkle tree is restaged and fsynced "
        "every five minutes to record that nothing moved, and every torrent "
        "counts against the save budget above whether or not it had anything "
        "to say.\n"
        "Confirm on this build with tools/resume-experiment.py, experiment E.",
        "The narrow conditions are not exposed by the 2.0 or 2.1 Python "
        "bindings, so the sidecar has to remember what it last wrote — a "
        "(state, total_done, num_pieces) triple per torrent is enough.",
    )


def read_catalog(config):
    """The catalog, as a list of entries."""
    path = os.path.join(config["dataDir"], "catalog.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        note(BAD, f"no catalog at {path}", "", "Check dataDir in the config.")
        return []
    except Exception as error:  # noqa: BLE001
        note(BAD, f"could not read {path}: {error}")
        return []
    if isinstance(data, dict):
        data = data.get("archives") or data.get("entries") or list(data.values())
    return [e for e in data if isinstance(e, dict) and e.get("infoHash")]


def examine(entry, config, lt, sample=3):
    """One archive's verdict.

    @param entry: The catalog entry.
    @param config: The resolved config.
    @param lt: The libtorrent module.
    @return: A dict describing what will happen on the next start.
    """
    info_hash = entry["infoHash"]
    resume_path = os.path.join(
        config["libtorrent"]["resumeDir"], f"{info_hash}.resume"
    )
    out = {
        "infoHash": info_hash,
        "name": entry.get("name") or "?",
        "complete": entry.get("complete"),
        "mode": entry.get("mode") or "mirror",
        # How it got here. A watched folder produces source.type 'file' and an
        # archive that was complete from its first moment; everything joined
        # from a peer or a feed spends real time partial, which is the only way
        # a partial bitfield reaches the disk in the first place.
        "source": (entry.get("source") or {}).get("type") or "?",
        "savePath": entry.get("savePath") or config["savePath"],
        "resumePath": resume_path,
        "resumeMtime": None,
        "resumeSavePath": "",
        "verdict": "",
        "why": "",
        "level": OK,
        "have": None,
        "pieces": None,
    }

    seed_only = entry.get("complete") is not False and out["mode"] != "cache"
    out["seedOnly"] = seed_only

    # Stat the resume file before anything can return early, or an archive
    # whose .torrent is missing reports as having no resume data either — two
    # quite different problems, told apart by which repair they want.
    if os.path.exists(resume_path):
        out["resumeMtime"] = os.path.getmtime(resume_path)

    # The recorded path wins, because that is the one restore reads. It can
    # point somewhere the configuration no longer does — moving dataDir does
    # not rewrite what the catalog already wrote down.
    recorded = entry.get("torrentPath")
    beside_datadir = os.path.join(config["dataDir"], "torrents", f"{info_hash}.torrent")
    torrent_path = recorded or beside_datadir
    out["torrentPath"] = torrent_path
    out["torrentElsewhere"] = bool(
        recorded and not os.path.exists(recorded) and os.path.exists(beside_datadir)
    )

    try:
        ti = lt.torrent_info(torrent_path)
    except Exception as error:  # noqa: BLE001
        out["verdict"] = "added as a magnet"
        out["level"] = BAD
        if out["torrentElsewhere"]:
            out["why"] = (
                f"the catalog points at {torrent_path}, which is not there, "
                f"while the file itself is at {beside_datadir}. Restore reads "
                "the recorded path, so it falls back to the magnet."
            )
        else:
            out["why"] = (
                f"no readable .torrent at {torrent_path} ({error}), so restore "
                "falls back to the magnet"
            )
        return out

    save_path = entry.get("savePath") or config["savePath"]
    out["pieces"] = ti.num_pieces()

    bits, priorities = [], []
    if out["resumeMtime"] is not None:
        try:
            with open(resume_path, "rb") as handle:
                atp = lt.read_resume_data(handle.read())
        except Exception as error:  # noqa: BLE001
            out["verdict"] = "full re-check"
            out["why"] = f"resume data is unreadable ({error}), so it is discarded"
            out["level"] = WARN
            return out

        named = v1_of(atp)
        if named and named != info_hash:
            out["verdict"] = "full re-check"
            out["why"] = (
                f"the resume file names {named[:12]}..., not this torrent, so "
                "the add is refused and it is discarded"
            )
            out["level"] = WARN
            return out

        bits = have_bits(atp)
        priorities = list(getattr(atp, "file_priorities", []) or [])
        out["have"] = sum(1 for bit in bits if bit)
        # The save path recorded inside can differ from the one restore hands
        # over. The add overwrites it, so this is reported rather than judged.
        out["resumeSavePath"] = getattr(atp, "save_path", "") or ""

    starts_as_seed = seed_mode_survives(seed_only, bits, priorities)
    verified, reason = predict_check(ti, bits, priorities, seed_only, save_path)

    # None rather than False: the file is present and the right length, but
    # this account cannot open it. libtorrent gets no further than the first
    # hash, so the check completes having found nothing.
    if verified is None:
        out["verdict"] = "UNREADABLE"
        out["why"] = (
            f"{reason}. The size is right, so nothing rejects the resume data "
            "— but hashing needs the bytes, and every piece fails. The check "
            "finishes at zero and records a full-length, all-false bitfield."
        )
        out["level"] = BAD
        return out

    if not verified:
        out["verdict"] = "full re-check"
        out["why"] = f"{reason} — fastresume is rejected and the store is re-hashed"
        out["level"] = BAD
        return out

    if starts_as_seed:
        out["verdict"] = "seeds at once"
        out["why"] = "seed_mode holds, so libtorrent only stats the files"
        out["level"] = OK
        return out

    if seed_only and bits and out["have"] < len(bits):
        missing = (len(bits) - out["have"]) * ti.piece_length()
        out["verdict"] = "POISONED"
        out["level"] = BAD
        # Nothing at all, at full length, is a different story from a
        # half-download: it says a check ran to completion and found not one
        # valid piece. The archive is almost certainly at 0% in the node right
        # now, and this file is the symptom rather than the cause.
        total = ti.num_pieces()
        # A bitfield shorter than the torrent is the signature of a save taken
        # while a check was running: write_resume_data truncates have_pieces to
        # m_num_checked_pieces in that state. Full length means the check
        # finished and this is what it concluded — a different problem with a
        # different cause, so they are never reported as the same thing.
        out["midCheck"] = len(bits) < total

        # Settle it by hashing, rather than believing the catalog. Every branch
        # below says the archive "already has" these bytes, and the only
        # evidence for that so far is the file's length. A file of the right
        # size holding different bytes — a build regenerated under the same
        # name, most obviously — fails every hash, and then the node is not
        # re-fetching what it has: it is correctly fetching what it does not.
        if sample > 0:
            checked, ok, why = sample_pieces(ti, save_path, bits, sample)
            out["sampled"] = (checked, ok, why)
            if checked and ok == 0:
                out["verdict"] = "not this data"
                out["level"] = WARN
                out["why"] = (
                    f"{checked} sampled pieces all failed their hash, so the "
                    f"file at {save_path} is the right length but is not this "
                    "torrent's data — most likely rebuilt under the same name. "
                    f"The {out['have']}/{total} in the resume file is accurate "
                    "and the download is real work, not a re-fetch of bytes "
                    "already held. The catalog calling this complete is the "
                    "thing that is wrong."
                )
                return out
            if checked and ok < checked:
                out["why"] = (
                    f"{ok} of {checked} sampled pieces hashed, so the file is "
                    "partly this torrent's data and partly not. "
                )

        if out["midCheck"]:
            out["why"] = (
                f"the resume file holds {out['have']}/{len(bits)} pieces of "
                f"{total} — shorter than the torrent, which is what a save "
                "taken during a check records (m_num_checked_pieces, "
                "torrent.cpp write_resume_data). seed_mode is dropped for it "
                f"(torrent.cpp:408), so it comes back meaning to fetch "
                f"{human(missing)} it already has, re-check, and write another "
                "one of these. Re-run in a few minutes: if the check has since "
                "finished, this heals itself and the verdict becomes 'seeds at "
                "once'."
            )
        elif out["have"] == 0:
            out["zeroed"] = True
            out["why"] = (
                f"the resume file records 0 of {total} pieces at full length — "
                "a check that finished and found nothing, not a partial "
                "download. seed_mode is dropped (torrent.cpp:408), so it comes "
                f"back meaning to fetch all {human(missing)} it already has."
            )
        else:
            out["why"] = (
                f"the resume file records {out['have']}/{total} pieces, so "
                "seed_mode is dropped (torrent.cpp:408) even though this "
                "archive is complete. It comes back partial and re-downloads "
                f"about {human(missing)} it already has."
            )
        return out

    if not bits:
        out["verdict"] = "seeds at once"
        out["why"] = "no resume data, but the seed_mode claim stands"
        out["level"] = OK if seed_only else WARN
        return out

    out["verdict"] = "resumes"
    out["why"] = f"{out['have']}/{len(bits)} pieces, and it is not claimed complete"
    out["level"] = OK
    return out


def report_archives(config, lt, entries, sample=3):
    heading("what each archive will do on the next start")
    if not entries:
        return []

    results = [examine(entry, config, lt, sample) for entry in entries]
    width = min(max(len(r["name"]) for r in results), 46)

    for result in sorted(results, key=lambda r: (r["level"] != BAD, r["name"])):
        name = result["name"]
        if len(name) > width:
            name = name[: width - 3] + "..."
        colour = colour_for(result["level"])
        print(
            f"  {colour}{MARK[result['level']]}{OFF}{name:<{width}}  "
            f"{colour}{result['verdict']:<18}{OFF}"
            f"{DIM}via {result['source']:<10} {result['mode']:<7}"
            f"resume {ago(result['resumeMtime']):>9}{OFF}"
        )
        print(f"      {DIM}{result['why']}{OFF}")

    return results


def report_catalog_paths(config, results):
    """Whether the catalog still points at its own .torrent files.

    Each entry records `torrentPath` as an absolute path, and restore reads
    that rather than recomputing it. Moving `dataDir` — which the service guide
    tells you to do, out of /etc — repoints the configuration and leaves every
    recorded path behind. Nothing warns, because a missing .torrent is not an
    error: restore silently falls back to the magnet.

    That fallback is the damage. A magnet carries no metadata, and resume data
    does not carry it either unless save_info_dict was asked for, which it is
    not. So the archive waits on BEP 9 for a file list — and for an archive this
    node built and is the only seeder of, there is nobody to ask. It sits in
    downloading_metadata, at 0%, serving nothing, for ever.
    """
    stale = [r for r in results if r["verdict"] == "added as a magnet"]
    if not stale:
        return

    heading("the catalog's .torrent paths")
    moved = [r for r in stale if r.get("torrentElsewhere")]
    print(f"  {len(stale)} of {len(results)} entries name a .torrent that is not there")

    if moved:
        old = os.path.dirname(moved[0]["torrentPath"])
        new = os.path.join(config["dataDir"], "torrents")
        note(
            BAD,
            "the files exist, and the catalog is pointing at where they used to be",
            f"recorded: {old}\nactually:  {new}\n"
            "This is what moving dataDir leaves behind. The configuration was "
            "repointed and the catalog was not, so every restore falls back to "
            "a magnet and waits on metadata that only a peer can supply — from "
            "a swarm where this node is the origin.",
            "Stop the service, back up catalog.json, and rewrite the prefix:\n"
            f"  python3 -c \"import json,pathlib; p=pathlib.Path('"
            f"{os.path.join(config['dataDir'], 'catalog.json')}'); "
            f"c=json.loads(p.read_text()); "
            f"[e.update(torrentPath=e['torrentPath'].replace('{old}','{new}')) "
            f"for e in c['entries'] if e.get('torrentPath')]; "
            f'p.write_text(json.dumps(c, indent=2))"',
        )
    else:
        note(
            BAD,
            f"{len(stale)} entries have no .torrent anywhere this can find",
            "\n".join(f"{r['name']}: {r['torrentPath']}" for r in stale[:6]),
            "Find where the torrents directory went and either move it beside "
            "dataDir or rewrite the recorded paths to match.",
        )


def report_duplicates(results, lt, sample):
    """Several catalog entries over one file on disk.

    A deliberate arrangement, and a common one here: the same archive is
    published at two piece sizes — one cut on this node, one adopted from the
    swarm as somebody else cut it — so peers on either torrent can be served
    from a single copy of the bytes. Different infohashes, different piece
    lengths, one file. Nothing about that is wrong.

    It is worth reporting for one reason and checking for another. The reason
    to report it: the file is hashed once *per torrent*, so a 698 GiB archive
    published twice is 1.4 TiB of reading every time the library re-checks, and
    on one spindle that is most of where the hours go.

    The reason to check it: sharing is only safe while the torrents describe
    identical bytes. They normally do — that is the whole point — but nothing
    enforces it, and if one of them is over a different build of the same name
    then whichever believes it is missing pieces will write its own version
    into the file the other is seeding. Hashing a piece against each torrent
    settles it, so the safe case is confirmed rather than assumed.

    @param results: What the archive pass found.
    @param lt: The libtorrent module.
    @param sample: How many pieces to hash per entry, 0 to skip.
    """
    by_file = {}
    for result in results:
        key = os.path.normcase(
            os.path.abspath(os.path.join(result["savePath"], result["name"]))
        )
        by_file.setdefault(key, []).append(result)

    shared = {path: group for path, group in by_file.items() if len(group) > 1}
    if not shared:
        return

    heading("archives sharing one file")
    disagreed = []
    doubled = 0
    for path, group in sorted(shared.items()):
        print(f"  {os.path.basename(path)}")
        for result in group:
            agrees = ""
            if sample > 0 and result.get("torrentPath"):
                try:
                    ti = lt.torrent_info(result["torrentPath"])
                    checked, ok, _ = sample_pieces(
                        ti, result["savePath"], [], min(sample, 2)
                    )
                    if checked:
                        agrees = f"  {ok}/{checked} sampled pieces match"
                        if ok < checked:
                            disagreed.append((path, result))
                        doubled += ti.total_size()
                except Exception:  # noqa: BLE001 - unreadable torrent, already reported
                    pass
            print(
                f"      {DIM}{result['infoHash'][:12]}...  "
                f"{result['pieces'] or '?'} pieces  via {result['source']}  "
                f"{result['verdict']}{agrees}{OFF}"
            )

    if disagreed:
        note(
            BAD,
            f"{len(disagreed)} of the shared torrents do not match the file",
            "Publishing one copy under two torrents is fine while both "
            "describe the same bytes. These do not, so whichever of them "
            "believes it is missing pieces will write its own version into the "
            "file the other is seeding.\n"
            + "\n".join(
                f"{r['name']} ({r['infoHash'][:12]}..., via {r['source']})"
                for _, r in disagreed[:6]
            ),
            "Remove the entry whose torrent is not over this file, keeping its "
            "data if another copy of it exists elsewhere.",
        )
    else:
        note(
            INFO,
            f"{len(shared)} files are published under more than one torrent",
            "Deliberate, and the sampled pieces agree: one copy of the bytes "
            "serving peers on both. Worth knowing only for what it costs a "
            "re-check — the file is hashed once per torrent, so this library "
            f"re-reads about {human(doubled)} rather than the size on disk, "
            "and on one spindle that is most of where the hours go.",
        )


def report_imports(config, results):
    """Whether how an archive arrived is what decides how it behaves.

    Worth asking separately because the two import paths differ in the one
    respect that matters here. A watched folder registers an archive that was
    read end to end a moment earlier: it is complete from its first moment,
    seed_mode is claimed for it immediately, and no partial bitfield ever
    exists to be written down. Anything joined from a feed, a magnet or a peer
    spends hours genuinely partial, so partial resume data for it is written
    every five minutes throughout — and one of those files surviving past
    completion is exactly the poison above.
    """
    heading("how each archive arrived")
    if not results:
        return

    by_source = {}
    for result in results:
        by_source.setdefault(result["source"], []).append(result)

    # 'file' is a watched folder or a local build; everything else is joined.
    local = {"file"}
    for source, group in sorted(by_source.items()):
        bad = sum(1 for r in group if r["level"] == BAD)
        kind = "built here" if source in local else "joined"
        print(f"  {source:<12} {len(group):>3} archives  ({kind})  {bad} in trouble")

    joined = [r for r in results if r["source"] not in local]
    joined_bad = [r for r in joined if r["level"] == BAD]
    built = [r for r in results if r["source"] in local]
    built_bad = [r for r in built if r["level"] == BAD]

    if joined and built and len(joined_bad) / len(joined) > 2 * (
        len(built_bad) / len(built) + 0.001
    ):
        note(
            WARN,
            "joined archives are in trouble far more often than built ones",
            "That is the expected shape of this failure rather than a separate "
            "one. A joined archive is partial for hours and has partial resume "
            "data written for it throughout; a built one is complete before it "
            "is ever registered and never has any. It is not the feed or the "
            "watcher introducing anything — it is which archives ever had a "
            "partial bitfield to leave behind.",
            "Fix the save path, not the import path.",
        )

    # Deliberately not judged on shape alone. A joined archive gets a directory
    # of its own only where the node had to fetch it; adopting one whose file is
    # already on this disk keeps the file where it is, quite correctly, and that
    # looks identical to a layout change from here. What settles it is whether
    # the data is actually at the recorded path — which every archive above was
    # already checked for — so this is reported and not warned about.
    layout = config.get("savePathLayout", "flat")
    if layout != "flat":
        root = os.path.abspath(config["savePath"])
        # Under 'infohash' the directory name is known exactly. Under 'name' it
        # is whatever the archive is called, sanitised, so the shape that can be
        # checked from here is the weaker one: a directory of its own under the
        # save root.
        if layout == "infohash":
            placed = lambda r: (
                os.path.basename(r["savePath"].rstrip("/\\")) == r["infoHash"]
            )
        else:
            placed = lambda r: os.path.dirname(os.path.abspath(r["savePath"])) == root
        elsewhere = [r for r in results if r["source"] not in local and not placed(r)]
        lost = [r for r in elsewhere if r["verdict"] in ("full re-check", "UNREADABLE")]
        if lost:
            note(
                BAD,
                f"{len(lost)} joined archives are outside the {layout} layout "
                "and their data was not found",
                "Shape alone is fine — an archive adopted from a file already "
                "on this disk keeps it. These are the ones where the recorded "
                "path did not answer.\n"
                + "\n".join(f"{r['name']}: {r['savePath']}" for r in lost[:6]),
                "Move them with Set location, or repoint the entry.",
            )
        elif elsewhere:
            note(
                INFO,
                f"{len(elsewhere)} joined archives sit outside the {layout} "
                "layout, and their data is where they say",
                "Which is an ordinary arrangement, not a fault: an archive "
                "adopted from a file this node already holds keeps that file "
                "rather than being moved into a directory of its own, and a "
                "node may deliberately keep archives beside whatever produced "
                "them. What matters is the next check.",
            )

    # Every place an archive actually lives has to be named in ReadWritePaths,
    # whatever the configuration says. ProtectSystem=strict refuses the write
    # inside the unit's namespace before any permission bit is consulted, so a
    # deliberately-placed archive is exactly the case that gets missed: the
    # config's own savePath is named and the folder holding the data is not.
    allowed = config.get("_readWritePaths")
    if allowed:
        uncovered = {}
        for result in results:
            save_path = os.path.abspath(result["savePath"])
            covered = any(
                save_path == part or save_path.startswith(part.rstrip("/") + "/")
                for part in allowed
            )
            if not covered:
                uncovered.setdefault(save_path, []).append(result["name"])
        if uncovered:
            note(
                BAD,
                f"{len(uncovered)} save paths in use are not under ReadWritePaths",
                "\n".join(
                    f"{path}  ({len(names)} archives)"
                    for path, names in sorted(uncovered.items())
                ),
                "Add each to ReadWritePaths in the unit, then daemon-reload. "
                "The permission bits on the directory are irrelevant until "
                "that is done.",
            )
        else:
            note(OK, "every save path in use is under ReadWritePaths")

    # Retention deleting a build out from under the torrent still seeding it.
    for folder in config.get("watch") or []:
        if not folder.get("keepDays"):
            continue
        root = os.path.abspath(os.path.join(config["_base"], folder["path"]))
        inside = [
            r
            for r in results
            if os.path.abspath(r["savePath"]).startswith(root.rstrip("/\\"))
        ]
        if inside:
            note(
                INFO,
                f"{len(inside)} archives live in a watched folder with "
                f"keepDays={folder['keepDays']}",
                f"{root}\nRetention removing a build removes the bytes a "
                "torrent is still seeding. The catalog entry outlives them, and "
                "the next start re-checks an archive whose file has gone.",
            )

    for subscription in config.get("subscriptions") or []:
        save_path = subscription.get("savePath")
        if save_path and not os.path.abspath(save_path).startswith(
            os.path.abspath(config["savePath"]).rstrip("/\\")
        ):
            note(
                INFO,
                f"a subscription saves outside the node's save path: {save_path}",
                "Legitimate, and worth confirming it is in ReadWritePaths — a "
                "refused write there looks exactly like a download that never "
                "progresses.",
            )


def report_resume_dir(config, results):
    """The resume directory itself: what is missing, stale or left over."""
    heading("the resume directory")
    resume_dir = config["libtorrent"]["resumeDir"]
    if not os.path.isdir(resume_dir):
        note(
            BAD,
            f"{resume_dir} does not exist",
            "Nothing has ever been written there, so every start re-checks "
            "every archive.",
            "Create it, and make sure the service can write to it.",
        )
        return

    known = {r["infoHash"] for r in results}
    orphans, staging, total = [], [], 0
    for name in sorted(os.listdir(resume_dir)):
        if name.endswith(".resume.new"):
            staging.append(name)
        elif name.endswith(".resume"):
            total += 1
            if name[: -len(".resume")] not in known:
                orphans.append(name)

    print(f"  {total} resume files for {len(known)} catalog entries")

    missing = [r for r in results if r["resumeMtime"] is None]
    if missing:
        note(
            WARN if len(missing) < len(results) else BAD,
            f"{len(missing)} archives have no resume file at all",
            "\n".join(r["name"] for r in missing[:8])
            + ("\n..." if len(missing) > 8 else ""),
            "These are cheap only while their seed_mode claim holds. Anything "
            "recorded incomplete re-hashes its whole store.",
        )
    if staging:
        note(
            WARN,
            f"{len(staging)} leftover .resume.new staging files",
            "\n".join(staging[:5]),
            "A write interrupted between the fsync and the rename. Safe to "
            "delete; their timestamps date the last unclean stop.",
        )
    if orphans:
        note(INFO, f"{len(orphans)} resume files with no catalog entry", "\n".join(orphans[:5]))

    stamps = [r["resumeMtime"] for r in results if r["resumeMtime"]]
    if not stamps:
        return
    print(f"  newest {ago(max(stamps))}, oldest {ago(min(stamps))}")

    interval = config.get("resumeSaveIntervalSeconds", 300)

    # The save is asked of every torrent at once, so a healthy library's resume
    # files are all about the same age. A spread wider than one interval means
    # cycles are finishing before they get through everything — and the ages
    # alone cannot say whether the same torrents lose every time.
    spread = max(stamps) - min(stamps)
    if len(stamps) > 1 and spread > interval * 1.5:
        note(
            WARN,
            f"resume files span {spread / 60:.0f} minutes, and the save "
            f"interval is {interval / 60:.0f}",
            "Every torrent is asked to save in the same cycle, so these should "
            "all be within one interval of each other. A spread this wide means "
            "some cycles are not getting through the whole library, and the "
            "archives at the old end are the ones that lose most from an "
            "unclean stop.",
            f"Measure it directly: re-run with --watch {int(interval * 2 + 60)}",
        )
    stale = [
        r
        for r in results
        if r["resumeMtime"] and time.time() - r["resumeMtime"] > interval * 4
    ]
    if stale:
        note(
            WARN,
            f"{len(stale)} resume files are older than four save intervals",
            "save_resume_data() clears the need flag on the call rather than on "
            "the write (torrent.cpp:10029), so a save dropped past the deadline "
            "is simply lost. It is asked again next cycle — measured, the flag "
            "re-arms within a second — so a file this old means the writes keep "
            "being dropped, not that the torrent stopped asking.\n"
            + "\n".join(f"{r['name']}: {ago(r['resumeMtime'])}" for r in stale[:8]),
            "Look at the save budgets above: something is cutting the write "
            "short every time, not once.",
        )


def report_journal(lines):
    """What the last few starts and stops actually said."""
    heading(f"the journal (last {lines} lines)")
    if not shutil.which("journalctl"):
        note(INFO, "no journalctl here")
        return
    try:
        raw = subprocess.run(
            ["journalctl", "-u", "pmtiles-swarm", "-n", str(lines), "--no-pager"],
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout
    except Exception as error:  # noqa: BLE001
        note(INFO, f"could not read the journal: {error}")
        return

    patterns = {
        r"\[resume\] \d+ of \d+ torrents wrote": (
            BAD,
            "a resume save fell short, and the shortfall is re-hashed next start",
        ),
        r"\[shutdown\] engine did not finish": (
            BAD,
            "the engine stop hit its 8s bound, so the sidecar was abandoned",
        ),
        r"\[shutdown\] took too long": (
            BAD,
            "the 15s shutdown watchdog fired and the process was exited",
        ),
        r"state 'stop-sigterm' timed out": (
            BAD,
            "systemd killed the unit rather than waiting for it",
        ),
        r"resume data for \S+ was refused": (
            WARN,
            "a resume file named the wrong torrent and was discarded",
        ),
        r"resume data for \S+ is unreadable": (
            WARN,
            "a resume file was corrupt and was discarded",
        ),
        r"fastresume_rejected": (
            WARN,
            "libtorrent refused resume data and re-checked",
        ),
        r"restore handed this to the engine and the engine is not": (
            BAD,
            "restore claimed an archive the engine never took",
        ),
    }
    seen = {}
    for line in raw.splitlines():
        for pattern, (level, meaning) in patterns.items():
            if re.search(pattern, line):
                seen.setdefault((level, meaning), []).append(line.strip())

    if not seen:
        note(OK, "nothing matching a known resume failure")
        return
    for (level, meaning), hits in sorted(seen.items()):
        note(level, f"{meaning} ({len(hits)}x)", "\n".join(hits[-3:]))


def summarise(results):
    heading("what to fix, worst first")
    poisoned = [r for r in results if r["verdict"] == "POISONED"]
    recheck = [r for r in results if r["verdict"] == "full re-check"]
    magnet = [r for r in results if r["verdict"] == "added as a magnet"]

    if magnet:
        note(
            BAD,
            f"{len(magnet)} archives will be restored as magnets, not torrents",
            "Restore falls back to the magnet when it cannot read the .torrent "
            "the catalog names, and says nothing. A magnet carries no metadata "
            "and neither does resume data, so the archive waits on BEP 9 for a "
            "file list — which no peer can supply for an archive this node "
            "originated. It sits at 0% in downloading_metadata indefinitely, "
            "which is not a re-check and no amount of rechecking will fix it.",
            "Repair the recorded paths; see 'the catalog's .torrent paths'.",
        )

    unreadable = [r for r in results if r["verdict"] == "UNREADABLE"]
    if unreadable:
        note(
            BAD,
            f"{len(unreadable)} archives are present and correctly sized but "
            "cannot be opened by this account",
            "This is the one failure that looks like everything else and is "
            "none of it. Nothing rejects the resume data, no size mismatch is "
            "reported, and the archive still ends at 0% — because hashing "
            "needs the bytes and the open fails. Run this script as the "
            "service account, or the check is answering for the wrong user.\n"
            + "\n".join(f"{r['name']}: {r['why']}" for r in unreadable[:6]),
            "Fix the mode or ownership on the data, then delete those resume "
            "files so the seed_mode claim can stand again.",
        )

    mid = [r for r in poisoned if r.get("midCheck")]
    if mid:
        note(
            BAD,
            f"{len(mid)} of those were written while a check was running",
            "This is the loop that keeps the problem alive, and it needs no "
            "restart to feed itself. An archive that re-checks is asked for "
            "resume data every resumeSaveIntervalSeconds throughout, and each "
            "of those saves records only the pieces checked so far. That "
            "shortened bitfield is what cancels seed_mode on the next start — "
            "so the archive comes back partial, re-checks, and writes another "
            "one.\n"
            "Re-run this in a few minutes before repairing anything. A check "
            "that has since finished rewrites its own resume file correctly, "
            "and the verdict becomes 'seeds at once' with nothing done to it. "
            "Only the archives that stay poisoned across two runs are worth "
            "deleting a file for.",
            "In op_save_resume, skip torrents in checking_files and "
            "checking_resume_data: their existing resume file is better than "
            "the one a check in progress would write.",
        )

    zeroed = [r for r in poisoned if r.get("zeroed")]
    if zeroed:
        note(
            BAD,
            f"{len(zeroed)} of those record zero pieces at full length",
            "A check that ran to completion and found not one valid piece, "
            "which is not what an interrupted download leaves behind. These "
            "archives are very likely sitting at 0% in the node right now, "
            "with the files complete on disk beside them — so the resume file "
            "is recording the damage rather than causing it, and it will be "
            "rewritten the same way every cycle until the cause is found.",
            "Confirm against the live node before repairing, so you can tell "
            "whether deleting the resume files actually holds: pmtiles-swarm "
            "status, or the console.",
        )

    if poisoned:
        note(
            BAD,
            f"{len(poisoned)} complete archives will come back partial",
            "A resume file holding a partial bitfield cancels the seed_mode "
            "claim outright, so the archive starts as a downloader with the "
            "whole file already on disk. Deleting these resume files is an "
            "immediate repair: with none, the claim stands and they seed at "
            "once.\n"
            + "\n".join(f"rm {r['resumePath']}" for r in poisoned[:10]),
            "Delete the listed resume files while the service is stopped.",
        )
    if recheck:
        note(
            BAD,
            f"{len(recheck)} archives will re-hash their whole store",
            "\n".join(f"{r['name']}: {r['why']}" for r in recheck[:6]),
        )

    ranked = sorted(findings, key=lambda finding: 0 if finding["level"] == BAD else 1)
    if not ranked:
        print(f"  {GREEN}nothing to fix{OFF}")
        return
    print()
    for index, finding in enumerate(ranked, 1):
        colour = RED if finding["level"] == BAD else YELLOW
        print(f"  {colour}{index}.{OFF} {finding['headline']}")
        if finding["fix"]:
            print(f"     {DIM}-> {finding['fix']}{OFF}")


def watch_saves(config, results, seconds):
    """Watches the periodic save actually happen, rather than inferring it.

    Everything else here reads one moment and reasons about it. This is the one
    question a snapshot cannot answer: whether the timer writes *every* torrent
    every cycle, or only some of them. A healthy library has all its resume
    files within one interval of each other, because the save is asked of every
    torrent at once. Ages spread across several intervals mean cycles are
    finishing early, and which torrents lose is not consistent.

    @param config: The resolved config.
    @param results: What the archive pass found.
    @param seconds: How long to watch. Two intervals plus slack is enough.
    """
    interval = config.get("resumeSaveIntervalSeconds", 300)
    heading(f"watching the periodic save for {seconds}s (interval is {interval}s)")

    known = {r["infoHash"]: r["name"] for r in results}
    seen = {r["infoHash"]: r["resumeMtime"] for r in results}
    written = {info_hash: 0 for info_hash in known}
    cycles = []

    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(min(5, max(1, interval / 60)))
        changed = []
        for info_hash in known:
            path = os.path.join(
                config["libtorrent"]["resumeDir"], f"{info_hash}.resume"
            )
            stamp = os.path.getmtime(path) if os.path.exists(path) else None
            if stamp and stamp != seen[info_hash]:
                seen[info_hash] = stamp
                written[info_hash] += 1
                changed.append(info_hash)
        if changed:
            cycles.append(changed)
            print(
                f"  {DIM}{time.strftime('%H:%M:%S')}  "
                f"{len(changed)} of {len(known)} written{OFF}"
            )

    if not cycles:
        note(
            WARN,
            f"nothing was written in {seconds}s",
            f"With a {interval}s interval this window should have covered at "
            "least one save. Either the timer is not running, or every write "
            "is failing.",
            "Check the journal for '[resume] could not save'.",
        )
        return

    never = [known[h] for h, count in written.items() if count == 0]
    full = [batch for batch in cycles if len(batch) == len(known)]
    print(
        f"  {len(cycles)} save cycles seen, {len(full)} of them covering "
        f"every archive"
    )
    if never:
        note(
            BAD,
            f"{len(never)} archives were never written in this window",
            "\n".join(never[:8]),
            "These are the ones carrying the oldest resume data, and the ones "
            "that lose the most from an unclean stop.",
        )
    elif len(full) < len(cycles):
        note(
            WARN,
            "some save cycles covered only part of the library",
            f"batch sizes: {', '.join(str(len(b)) for b in cycles)} of "
            f"{len(known)}\nA cycle that writes only some torrents leaves the "
            "rest carrying older data than the interval suggests.",
            "Compare against the save budgets above.",
        )
    else:
        note(OK, "every cycle wrote every archive")


def main():
    parser = argparse.ArgumentParser(
        description="Why a pmtiles-swarm archive re-checks instead of resuming."
    )
    parser.add_argument(
        "--watch",
        type=int,
        default=0,
        metavar="SECONDS",
        help="after reporting, watch the resume directory for this long and "
        "say which archives the periodic save actually writes",
    )
    parser.add_argument(
        "-c",
        "--config",
        default="/etc/pmtiles-swarm/swarm.config.json",
        help="path to swarm.config.json",
    )
    parser.add_argument(
        "--verify",
        type=int,
        default=3,
        metavar="PIECES",
        help="hash this many pieces of any archive that looks poisoned, to "
        "prove the bytes really are there. 0 to skip the reads",
    )
    parser.add_argument(
        "--journal",
        type=int,
        default=2000,
        help="how many journal lines to scan, or 0 to skip",
    )
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--no-color", action="store_true")
    args = parser.parse_args()

    if args.no_color or not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
        plain()

    config = load_config(args.config)
    reexec_under_sidecar_python(config, sys.argv)

    try:
        import libtorrent as lt
    except ImportError:
        print(
            f"{RED}this interpreter ({sys.executable}) has no libtorrent.{OFF}\n"
            "Run it with the one the sidecar uses — libtorrent.python in the "
            "config, which for a venv install is that venv's bin/python."
        )
        return 2

    print(f"{BOLD}pmtiles-swarm resume doctor{OFF}")
    report_environment(config, lt, args.config)

    entries = read_catalog(config)
    report_unit(config, len(entries))
    report_save_budgets(len(entries))
    report_gate()
    results = report_archives(config, lt, entries, args.verify)
    report_catalog_paths(config, results)
    report_duplicates(results, lt, args.verify)
    report_imports(config, results)
    report_resume_dir(config, results)
    if args.journal:
        report_journal(args.journal)
    summarise(results)
    if args.watch:
        watch_saves(config, results, args.watch)

    if args.json:
        print(json.dumps({"archives": results, "findings": findings}, indent=2))

    return 1 if any(finding["level"] == BAD for finding in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
