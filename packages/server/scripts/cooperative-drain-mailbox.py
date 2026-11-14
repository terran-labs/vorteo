#!/usr/bin/env python3
"""Fixed native mailbox storage. This helper creates no directory or authority.

The native caller must admit and durably consume the exact grant before publish.
Observers are unprivileged. Their output is transport data, never settlement proof.
"""
import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys
import time
import uuid

OPERATION = "maintenance.interrupt-held-turns"
MAX_BYTES = 32768
MAX_ENTRIES = 32
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def check(value, message):
    if not value:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def directory(path, owner):
    check(isinstance(path, str) and path.startswith("/") and
          os.path.normpath(path) == path and "\x00" not in path,
          "Noncanonical mailbox path")
    fd = os.open("/", FLAGS)
    try:
        for part in path.split("/")[1:]:
            if not part:
                continue
            child = os.open(part, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            check(info.st_uid in (0, owner) and info.st_mode & 0o022 == 0,
                  "Mailbox ancestor is writable outside native custody")
        check(os.fstat(fd).st_uid == owner, "Mailbox directory owner differs")
        return fd
    except BaseException:
        os.close(fd)
        raise


def names_bounded(parent):
    names = []
    with os.scandir(parent) as entries:
        for entry in entries:
            names.append(entry.name)
            check(len(names) <= MAX_ENTRIES, "Native mailbox entry budget exhausted")
    return names


def read_file(parent, name, owner, limit=MAX_BYTES):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(fd)
        check(stat.S_ISREG(before.st_mode) and before.st_uid == owner and
              before.st_mode & 0o022 == 0 and before.st_nlink == 1 and
              0 < before.st_size <= limit, "Invalid native mailbox file custody")
        data = os.read(fd, limit + 1)
        after = os.fstat(fd)
        check(len(data) == before.st_size and len(data) <= limit and
              (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
               before.st_ctime_ns) ==
              (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
               after.st_ctime_ns), "Native mailbox file changed during read")
        return data
    finally:
        os.close(fd)


def scope_file(path, expected, owner):
    parent = directory(os.path.dirname(path), owner)
    try:
        value = json.loads(read_file(parent, os.path.basename(path), owner, 8192))
    finally:
        os.close(parent)
    check(set(value) == {"version", "operation", "installationId", "target",
                         "containerId", "mailboxPath", "mailboxIdentity", "ownerUid", "readerUid", "processInspector"},
          "Unknown native mailbox scope field")
    check(value["version"] == 1 and value["operation"] == OPERATION and
          value["ownerUid"] == owner and value["target"] in ("host", "container-daemon") and
          isinstance(value["readerUid"], int) and value["readerUid"] >= 0 and
          digest(value) == expected, "Native mailbox scope differs from enrolled endpoint")
    identity = value["mailboxIdentity"]
    check(isinstance(identity, dict) and set(identity) == {"device", "inode"} and
          all(isinstance(item, str) and item.isdecimal() for item in identity.values()),
          "Native mailbox inode identity is unavailable")
    uuid.UUID(value["installationId"])
    if value["target"] == "container-daemon":
        check(isinstance(value["containerId"], str) and len(value["containerId"]) == 64 and
              all(c in "0123456789abcdef" for c in value["containerId"]),
              "Native mailbox requires exact container identity")
    else:
        check(value["containerId"] is None, "Host scope cannot name a container")
    return value


def envelope(value, endpoint):
    check(isinstance(value, dict) and set(value) == {"operation", "endpointIdentitySha256",
          "reservationSha256", "reservation"} and value["operation"] == OPERATION and
          value["endpointIdentitySha256"] == endpoint,
          "Invalid cooperative preparation envelope")
    reservation = value["reservation"]
    check(isinstance(reservation, dict) and digest(reservation) == value["reservationSha256"] and
          reservation.get("operation") == OPERATION and reservation.get("phase") == "reserved" and
          reservation.get("endpointIdentitySha256") == endpoint,
          "Envelope does not name its immutable reserved phase")
    held = reservation["intent"]["held"]
    generation = str(uuid.UUID(held["generation"]))
    uuid.UUID(held["requestId"])
    uuid.UUID(reservation["intent"]["approvedRevision"])
    uuid.UUID(reservation["intent"]["grantRevision"])
    uuid.UUID(reservation["intent"]["holdGeneration"])
    uuid.UUID(held["workerInstanceId"])
    remaining = held["terminateAt"] - int(time.time() * 1000)
    check(isinstance(held["workerPid"], int) and held["workerPid"] > 0 and
          0 < remaining <= 300000, "Cooperative preparation deadline or worker differs")
    return generation


def create_file(parent, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o400, dir_fd=parent)
    try:
        os.fchmod(fd, 0o444)
        offset = 0
        while offset < len(data):
            written = os.write(fd, data[offset:])
            check(written > 0, "Short native mailbox write")
            offset += written
        os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(parent)


def prune_expired(parent, owner):
    # Only expired native-owned mailbox data are retired. The authoritative
    # coordinator attempt is retained; deleting transport bytes never permits replay.
    now = int(time.time() * 1000)
    for name in names_bounded(parent):
        if not name.endswith(".claim"):
            continue
        generation = str(uuid.UUID(name[:-6]))
        claim = json.loads(read_file(parent, name, owner, 1024))
        check(claim.get("generation") == generation and
              isinstance(claim.get("terminateAt"), int), "Invalid native claim lifetime")
        if claim["terminateAt"] > now:
            continue
        for suffix in (".json", ".partial", ".claim"):
            entry = generation + suffix
            try:
                info = os.stat(entry, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                continue
            check(stat.S_ISREG(info.st_mode) and info.st_uid == owner and
                  info.st_nlink == 1 and info.st_mode & 0o022 == 0,
                  "Expired mailbox entry custody changed")
            os.unlink(entry, dir_fd=parent)
        os.fsync(parent)


def publish(parent, value, endpoint, owner):
    check(os.geteuid() == owner, "Only the registered native owner may publish")
    generation = envelope(value, endpoint)
    data = canonical(value)
    check(len(data) <= MAX_BYTES, "Cooperative envelope exceeds byte budget")
    prune_expired(parent, owner)
    check(len(names_bounded(parent)) + 3 <= MAX_ENTRIES, "Native mailbox entry budget exhausted")
    # A durable claim precedes every publication. Any exception thereafter is
    # uncertainty, never permission to retry this generation or replace a file.
    create_file(parent, generation + ".claim", canonical({
        "generation": generation, "envelopeSha256": hashlib.sha256(data).hexdigest(),
        "terminateAt": value["reservation"]["intent"]["held"]["terminateAt"]}))
    temporary = generation + ".partial"
    create_file(parent, temporary, data)
    os.link(temporary, generation + ".json", src_dir_fd=parent,
            dst_dir_fd=parent, follow_symlinks=False)
    os.unlink(temporary, dir_fd=parent)
    os.fsync(parent)
    return {"generation": generation, "state": "published"}


def observe(parent, endpoint, owner):
    names = names_bounded(parent)
    result = []
    for name in sorted(names):
        if not name.endswith(".json"):
            continue
        generation = str(uuid.UUID(name[:-5]))
        value = json.loads(read_file(parent, name, owner))
        try:
            check(envelope(value, endpoint) == generation, "Mailbox generation differs")
        except ValueError as error:
            if "deadline" in str(error):
                continue
            raise
        claim = json.loads(read_file(parent, generation + ".claim", owner, 1024))
        check(claim == {"generation": generation,
              "envelopeSha256": hashlib.sha256(canonical(value)).hexdigest(),
              "terminateAt": value["reservation"]["intent"]["held"]["terminateAt"]},
              "Native publication has no matching durable consumed claim")
        result.append(value)
    return result


def process_identity(scope, pid, owner):
    if sys.platform == "linux":
        with open("/proc/sys/kernel/random/boot_id", encoding="utf8") as file:
            boot = file.read(128).strip()
        with open("/proc/%d/stat" % pid, encoding="utf8") as file:
            text = file.read(8192)
        fields = text[text.rfind(")") + 1:].split()
        check(fields[0] not in ("Z", "X"), "Reserved process exited")
        with open("/proc/%d/status" % pid, encoding="utf8") as file:
            status_text = file.read(32768)
        uid_line = next(line for line in status_text.splitlines() if line.startswith("Uid:"))
        uids = list(map(int, uid_line.split()[1:]))
        check(len(set(uids)) == 1, "Reserved process credentials differ")
        return {"pid": pid, "parentPid": int(fields[1]), "uid": uids[0],
                "bootId": boot, "startIdentity": fields[19]}
    check(sys.platform == "darwin", "Unsupported cooperative native process inspection")
    reference = scope["processInspector"]
    check(isinstance(reference, dict) and set(reference) == {"path", "sha256"},
          "Host process inspector is not registered")
    parent = directory(os.path.dirname(reference["path"]), owner)
    try:
        source = read_file(parent, os.path.basename(reference["path"]), owner, 131072)
    finally:
        os.close(parent)
    check(hashlib.sha256(source).hexdigest() == reference["sha256"],
          "Host process inspector differs from registered source")
    result = subprocess.run([sys.executable, "-I", "-B", "-c", source.decode("utf8"),
                             str(pid), "--require-running"],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=3, check=True)
    check(len(result.stdout) <= 16384, "Native process observation exceeds byte budget")
    return json.loads(result.stdout)


def consume(parent, endpoint, owner, scope):
    # This helper was spawned by the actual supervisor. Never accept a claimed
    # caller PID from input, a file or an environment variable as parent proof.
    parent_pid = os.getppid()
    current = process_identity(scope, parent_pid, owner)
    values = []
    for value in observe(parent, endpoint, owner):
        intent = value["reservation"]["intent"]
        expected = intent["native"]["supervisor"]
        keys = ("pid", "parentPid", "uid", "bootId", "startIdentity")
        if any(current[key] != expected[key] for key in keys):
            continue
        worker = process_identity(scope, intent["held"]["workerPid"], owner)
        expected_worker = intent["native"]["worker"]
        if worker["parentPid"] != parent_pid or any(
                worker[key] != expected_worker[key] for key in keys):
            continue
        # Recheck the genuine parent and both birth identities after the read.
        again = process_identity(scope, parent_pid, owner)
        check(all(again[key] == current[key] for key in keys), "Supervisor lifetime changed")
        child_again = process_identity(scope, worker["pid"], owner)
        check(all(child_again[key] == worker[key] for key in keys), "Worker lifetime changed")
        values.append(value)
    return values


def main():
    check(hasattr(os, "O_NOFOLLOW") and os.open in os.supports_dir_fd and
          os.link in os.supports_dir_fd, "Native mailbox fd-relative custody is unavailable")
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("publish", "observe", "consume", "preflight"))
    parser.add_argument("--scope", required=True)
    parser.add_argument("--endpoint-sha256", required=True)
    parser.add_argument("--owner-uid", required=True, type=int)
    args = parser.parse_args()
    scope = scope_file(args.scope, args.endpoint_sha256, args.owner_uid)
    root = directory(scope["mailboxPath"], args.owner_uid)
    try:
        root_info = os.fstat(root)
        check(scope["mailboxIdentity"] == {"device": str(root_info.st_dev),
              "inode": str(root_info.st_ino)}, "Native mailbox directory identity changed")
        if args.operation == "publish":
            raw = sys.stdin.buffer.read(MAX_BYTES + 1)
            check(0 < len(raw) <= MAX_BYTES, "Invalid native envelope byte budget")
            result = publish(root, json.loads(raw), args.endpoint_sha256, args.owner_uid)
        elif args.operation == "consume":
            check(os.geteuid() == scope["readerUid"], "Cooperative observer account differs")
            result = consume(root, args.endpoint_sha256, args.owner_uid, scope)
        elif args.operation == "observe":
            result = observe(root, args.endpoint_sha256, args.owner_uid)
        else:
            result = {"capability": OPERATION, "endpointIdentitySha256": args.endpoint_sha256}
        print(json.dumps(result, separators=(",", ":")))
    finally:
        os.close(root)


if __name__ == "__main__":
    main()
