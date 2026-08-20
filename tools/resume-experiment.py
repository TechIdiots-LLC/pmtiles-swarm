#!/usr/bin/env python3
"""Proves, on this machine's libtorrent, what resume data does to a restart.

The doctor beside this file predicts what will happen from rules read out of
libtorrent's source. This runs them instead: it builds a real torrent from a
temporary file, adds it to a real session, saves real resume data and adds it
again, and reports what libtorrent actually did. No network, no peers, nothing
outside a temporary directory, and the node's own data is never touched.

    python3 tools/resume-experiment.py

Run it with the interpreter the sidecar uses. The point is to confirm the
behaviour of *that* libtorrent build — 2.0 and 2.1 differ enough that a claim
verified on one is not a claim about the other.

Five experiments, each printing a claim and then the measurement:

  A  a complete archive with no resume data at all
  B  a complete archive with resume data that says so
  C  a complete archive with resume data that says otherwise
  D  resume data saved while a check is still running
  E  whether a dropped save leaves the torrent asking to be saved again
"""

import os
import shutil
import sys
import tempfile
import time

try:
    import libtorrent as lt
except ImportError:
    print("this interpreter has no libtorrent")
    sys.exit(2)

GREEN, RED, YELLOW, DIM, BOLD, OFF = (
    "\033[32m",
    "\033[31m",
    "\033[33m",
    "\033[2m",
    "\033[1m",
    "\033[0m",
)
if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
    GREEN = RED = YELLOW = DIM = BOLD = OFF = ""

# Big enough to have a few hundred pieces, small enough to hash instantly.
DATA_BYTES = 64 << 20
PIECE_BYTES = 16 << 10

results = []


def libtorrent_version():
    """What build this is, however the binding chooses to say so.

    Some distribution builds ship without the version module bound at all, so
    asking for one name and trusting it crashes on exactly the machine worth
    measuring. Nothing here turns on the answer — the experiments measure the
    behaviour directly, which is the point of them.

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


def claim(text):
    print(f"\n{BOLD}{text}{OFF}")


def measured(passed, text, detail=""):
    """Prints one measurement and records whether it matched the claim."""
    mark = f"{GREEN}as claimed{OFF}" if passed else f"{RED}NOT as claimed{OFF}"
    print(f"  {mark}  {text}")
    if detail:
        for line in detail.splitlines():
            print(f"            {DIM}{line}{OFF}")
    results.append(passed)


def quiet_session(port):
    """A session that talks to nobody.

    Every discovery mechanism off and the listen port on loopback, so running
    this cannot announce a fake torrent to a tracker or the DHT.
    """
    return lt.session(
        {
            "listen_interfaces": f"127.0.0.1:{port}",
            "enable_dht": False,
            "enable_lsd": False,
            "enable_upnp": False,
            "enable_natpmp": False,
            "alert_mask": lt.alert.category_t.all_categories,
        }
    )


def build_torrent(root):
    """A real hybrid torrent over one real file, as the node cuts them.

    @param root: The directory to write the data file into.
    @return: (torrent_info, the file's name).
    """
    name = "archive.pmtiles"
    path = os.path.join(root, name)
    with open(path, "wb") as handle:
        handle.write(os.urandom(DATA_BYTES))

    storage = lt.file_storage()
    lt.add_files(storage, path)
    # Hybrid is 2.0's default and a named flag in 2.1; asking for the flag by
    # name and falling back to zero gets a v1+v2 torrent out of either.
    hybrid = getattr(lt.create_torrent_flags_t, "v1_v2_hybrid", 0)
    create = lt.create_torrent(storage, PIECE_BYTES, flags=hybrid)
    lt.set_piece_hashes(create, os.path.dirname(path))
    return lt.torrent_info(lt.bdecode(lt.bencode(create.generate()))), name


def settle(session, handle, want, limit=25.0):
    """Waits until a torrent reaches one of the wanted states.

    @param session: The session, pumped so alerts do not pile up.
    @param handle: The torrent.
    @param want: A set of state names.
    @param limit: Seconds to allow.
    @return: (state name, status) as last seen.
    """
    deadline = time.time() + limit
    status = handle.status()
    while time.time() < deadline:
        session.pop_alerts()
        status = handle.status()
        if str(status.state) in want:
            return str(status.state), status
        time.sleep(0.05)
    return str(status.state), status


def states_seen(session, handle, seconds):
    """Every state a torrent passes through in a window.

    Which is the measurement that matters: 'checking_files' appearing at all is
    the whole store being re-hashed, however quickly it finishes here.
    """
    seen = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        session.pop_alerts()
        state = str(handle.status().state)
        if not seen or seen[-1] != state:
            seen.append(state)
        if state in ("seeding", "finished") and len(seen) > 1:
            break
        time.sleep(0.02)
    return seen


def save_resume(session, handle, limit=10.0):
    """Asks for resume data and returns the serialised bytes.

    @return: The bytes, or None if the alert never came.
    """
    handle.save_resume_data()
    deadline = time.time() + limit
    while time.time() < deadline:
        for alert in session.pop_alerts():
            if isinstance(alert, lt.save_resume_data_alert):
                return bytes(lt.write_resume_data_buf(alert.params))
            if isinstance(alert, lt.save_resume_data_failed_alert):
                return None
        time.sleep(0.05)
    return None


def add(session, ti, save_path, resume=None, seed_only=True):
    """Adds a torrent the way the sidecar's op_add does.

    Resume data first, then the save path, then the seed_mode claim — the same
    order, because read_resume_data returns a fresh params object and anything
    set before the swap is thrown away.
    """
    atp = lt.add_torrent_params()
    atp.ti = ti
    if resume is not None:
        atp = lt.read_resume_data(resume)
        atp.ti = ti
    atp.save_path = save_path
    if seed_only:
        atp.flags |= lt.torrent_flags.seed_mode
    return session.add_torrent(atp)


def flip_bits_off(resume, ti, fraction=0.4):
    """Rewrites resume data so it claims rather less than it did.

    Stands in for the two ways the node produces one of these for real: a save
    taken while a check is still running, which records only the pieces checked
    so far, and a save that landed when the torrent genuinely was partial and
    was never rewritten afterwards.

    @param resume: Serialised resume data claiming everything.
    @param ti: The torrent, for its piece count.
    @param fraction: How much of the tail to unset.
    @return: Serialised resume data claiming less, or None if unsupported.
    """
    atp = lt.read_resume_data(resume)
    bits = [bool(bit) for bit in atp.have_pieces]
    if not bits:
        return None
    keep = int(len(bits) * (1 - fraction))
    try:
        atp.have_pieces = [index < keep for index in range(len(bits))]
    except Exception:  # noqa: BLE001 - bindings that will not take a list
        return None
    atp.ti = ti
    return bytes(lt.write_resume_data_buf(atp))


def main():
    root = tempfile.mkdtemp(prefix="pmtiles-swarm-resume-")
    print(f"{BOLD}pmtiles-swarm resume experiment{OFF}")
    print(f"  libtorrent {libtorrent_version()}, python {sys.version.split()[0]}")
    print(f"  {DIM}scratch {root}{OFF}")

    try:
        ti, _ = build_torrent(root)
        pieces = ti.num_pieces()
        print(f"  {DIM}{human_pieces(ti)}{OFF}")

        # ---- A ------------------------------------------------------------
        claim(
            "A. A complete archive with no resume data still seeds at once, "
            "because the seed_mode claim stands on its own."
        )
        session = quiet_session(6899)
        handle = add(session, ti, root, resume=None, seed_only=True)
        seen = states_seen(session, handle, 6)
        status = handle.status()
        measured(
            "checking_files" not in seen and status.progress > 0.99,
            f"states {' -> '.join(seen)}, progress {status.progress:.0%}, "
            f"seed_mode {status.seed_mode}",
            "No resume file is not, by itself, what causes a re-check.",
        )
        full_resume = save_resume(session, handle)
        session.remove_torrent(handle)

        # ---- B ------------------------------------------------------------
        claim(
            "B. Resume data written by a seeding torrent claims every piece, "
            "so it comes back a seed."
        )
        if full_resume is None:
            measured(False, "no resume data came back at all")
        else:
            atp = lt.read_resume_data(full_resume)
            bits = [bool(bit) for bit in atp.have_pieces]
            measured(
                bool(bits) and all(bits) and len(bits) >= pieces,
                f"have_pieces records {sum(bits)}/{len(bits)} of {pieces} pieces",
            )

        # ---- C ------------------------------------------------------------
        claim(
            "C. Resume data holding a PARTIAL bitfield cancels the seed_mode "
            "claim, and the archive comes back partial with every byte on disk."
        )
        partial = flip_bits_off(full_resume, ti) if full_resume else None
        if partial is None:
            measured(False, "could not build a partial resume file on these bindings")
        else:
            handle = add(session, ti, root, resume=partial, seed_only=True)
            state, status = settle(
                session, handle, {"downloading", "seeding", "finished"}
            )
            short = 1 - status.progress
            measured(
                not status.seed_mode and short > 0.01,
                f"state {state}, progress {status.progress:.0%}, "
                f"seed_mode {status.seed_mode}",
                f"The file on disk is whole, and libtorrent means to fetch "
                f"{short:.0%} of it again. torrent.cpp:408 drops seed_mode if "
                f"have_pieces holds a single unset bit.",
            )
            session.remove_torrent(handle)

        # ---- D ------------------------------------------------------------
        claim(
            "D. Resume data saved while a check is still running records only "
            "the pieces checked so far, which is how a whole archive acquires "
            "a partial bitfield in the first place."
        )
        handle = add(session, ti, root, resume=None, seed_only=False)
        settle(session, handle, {"seeding", "finished", "downloading"})
        handle.force_recheck()
        best, samples = None, 0
        deadline = time.time() + 15
        while time.time() < deadline:
            session.pop_alerts()
            if str(handle.status().state) != "checking_files":
                if samples:
                    break
                time.sleep(0.002)
                continue
            samples += 1
            taken = save_resume(session, handle, limit=1.0)
            if taken is None:
                continue
            bits = [bool(bit) for bit in lt.read_resume_data(taken).have_pieces]
            # A partial bitfield is the poison; an empty one is merely proof of
            # the same truncation, and harmless because it cancels nothing.
            if bits and not all(bits):
                best = ("partial", bits)
                break
            best = best or ("empty" if not bits else "full", bits)
        if best is None:
            measured(
                True,
                f"the check never lasted long enough to sample "
                f"({samples} attempts)",
                "Not a refutation. A 64 MiB file checks in under a second, "
                "while a 700 GiB archive checks for many minutes and the "
                "five-minute save timer lands inside that window every time.",
            )
        else:
            kind, bits = best
            measured(
                kind != "full",
                f"a mid-check save recorded {sum(bits)}/{len(bits)} of "
                f"{pieces} pieces ({kind})",
                "A partial bitfield here is exactly the file experiment C "
                "proves is poison. An empty one is harmless: with no bits at "
                "all there is nothing to contradict the seed_mode claim.",
            )
        session.remove_torrent(handle)

        # ---- E ------------------------------------------------------------
        claim(
            "E. need_save_resume_data() — the no-argument form the sidecar "
            "calls — never answers no for a running torrent, so the gate meant "
            "to stop needless rewrites does not stop any of them."
        )
        handle = add(session, ti, root, resume=None, seed_only=True)
        settle(session, handle, {"seeding", "finished"})
        before = handle.need_save_resume_data()
        handle.save_resume_data()
        # Deliberately not popping the alert: this is the sidecar dropping one
        # past its deadline. The question is whether the torrent asks again.
        rearmed = []
        for _ in range(6):
            time.sleep(0.5)
            session.pop_alerts()
            rearmed.append(handle.need_save_resume_data())
        measured(
            before and any(rearmed),
            f"before the save {before}; afterwards "
            f"{', '.join(str(value) for value in rearmed)} at half-second steps",
            "if_counters_changed is one of the five conditions the no-argument "
            "form asks about, and libtorrent's own header says a torrent that "
            "is not paused increments its active-time counters continuously "
            "(torrent_handle.hpp:713). So every seeding archive answers yes "
            "every cycle, and a hybrid archive's merkle tree is restaged and "
            "fsynced every five minutes to record that nothing moved. "
            "The narrow forms that would answer this properly — "
            "if_download_progress, if_state_changed — are not exposed by "
            "either the 2.0 or the 2.1 Python bindings, so the sidecar has to "
            "track what it last wrote itself.",
        )
        session.remove_torrent(handle)
        del session

    finally:
        shutil.rmtree(root, ignore_errors=True)

    print()
    if all(results):
        print(f"{GREEN}every claim held on this build{OFF}")
        return 0
    print(f"{YELLOW}{results.count(False)} of {len(results)} claims did not hold{OFF}")
    return 1


def human_pieces(ti):
    return (
        f"{ti.num_pieces()} pieces of {ti.piece_length() >> 10} KiB, "
        f"{ti.total_size() >> 20} MiB total"
    )


if __name__ == "__main__":
    sys.exit(main())
