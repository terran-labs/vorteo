#!/usr/bin/env python3
"""Bounded host consumer. Requests are data; all host commands are fixed argv."""
import hashlib
from itertools import islice
import json
import os
from pathlib import Path
import re
import stat
import socket
import subprocess
import sys
import time
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_config import load
from channel_identity import broker_lock, verify_channel, verify_fence

MAX_BYTES = 4096
ID = re.compile(r'^[a-f0-9-]{36}$')
WS = re.compile(r'^wks_[a-zA-Z0-9_-]{1,80}$')
SERVICE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$')
# A check that times out proves nothing about the backend, so a verified route
# survives a short run of them. The route is withdrawn on the third consecutive
# timeout, or once this many seconds have passed since its last full
# verification, whichever comes first. Every other failure withdraws at once.
TIMEOUT_MISS_LIMIT = 3
TIMEOUT_GRACE_SECONDS = 90
# Both installers run the broker every BROKER_INTERVAL_SECONDS (launchd StartInterval),
# and each run spends at most RECONCILE_SECONDS rechecking entries.
BROKER_INTERVAL_SECONDS = 10
RECONCILE_SECONDS = 20
# A stopped service is attributed to a daemon restart only when the new daemon worker
# started within one broker cycle of the last verification under the old one. While the
# broker keeps its cadence, an exit earlier than that would have been seen and recorded
# as 'exited' first. A longer gap leaves room for an unrelated exit: no cause is recorded.
RESTART_ATTRIBUTION_SECONDS = BROKER_INTERVAL_SECONDS + RECONCILE_SECONDS
# Owner-readable preview state for the daemon and helper, at the pinned channel root.
STATUS_FILE = 'preview-status.json'
STATUS_FIELDS = ('workspaceId', 'service', 'frontend', 'desired', 'status', 'stopReason',
                 'stoppedAt', 'restartedAt', 'verifiedAt', 'checkedAt', 'needsReview', 'error')
UNVERIFIED_MESSAGE = re.compile(r'Checks timed out \(\d+ of \d+\); route kept but unverified')
IDENTIFIER = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,63}')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def safe_read(path, limit=65536):
    # Reject symlinks in every component, not only the leaf.
    path = Path(path).absolute()
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        leaf = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(leaf)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
                raise ValueError('Unsafe file or size bound exceeded')
            data = os.read(leaf, limit + 1)
            if len(data) > limit:
                raise ValueError('Size bound exceeded')
            return json.loads(data)
        finally:
            os.close(leaf)
    finally:
        os.close(fd)


def project_config(path):
    """paseo.json with paseo.local.json script entries merged over it, as the daemon runs it."""
    cfg = safe_read(path / 'paseo.json')
    try:
        local = safe_read(path / 'paseo.local.json')
    except FileNotFoundError:
        return cfg
    overrides = local.get('scripts') if isinstance(local, dict) else None
    if not isinstance(overrides, dict):
        return cfg
    scripts = dict(cfg.get('scripts') or {})
    for name, override in overrides.items():
        base = scripts.get(name)
        scripts[name] = {**base, **override} if isinstance(base, dict) and isinstance(override, dict) else override
    return {**cfg, 'scripts': scripts}


def safe_dir(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).absolute().parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except Exception:
        os.close(fd)
        raise


def private_directory(path):
    """Fail closed unless this is a real directory, owned by this user, closed to others.

    Installers write executable broker files, pins and node state into such directories.
    An existing one is never adopted on trust or silently tightened: another local user
    who can write there could replace what the broker runs.
    """
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f'{path} must be a directory owned by this user with mode 0700')


def atomic(path, value, mode=0o600):
    path = Path(path)
    fd = safe_dir(path.parent)
    name = '.' + str(uuid.uuid4())
    try:
        out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
        with os.fdopen(out, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(name, path.name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)


def validate(request, now):
    if not isinstance(request, dict) or set(request) - {'id', 'operation', 'workspaceId', 'service', 'preferredPort', 'createdAt'}:
        raise ValueError('Unsupported request fields')
    if not ID.fullmatch(str(request.get('id', ''))) or not WS.fullmatch(str(request.get('workspaceId', ''))) or not SERVICE.fullmatch(str(request.get('service', ''))):
        raise ValueError('Invalid request identity')
    if request.get('operation') not in ('start', 'restart', 'stop', 'status'):
        raise ValueError('Unsupported lifecycle operation')
    created = request.get('createdAt')
    if type(created) not in (float, int) or not now - 120 <= created <= now + 5:
        raise ValueError('Request expired or clock differs')
    port = request.get('preferredPort')
    if port is not None and (type(port) is not int or not 32768 <= port <= 60999):
        raise ValueError('Invalid preferred frontend port')
    return request


class RecoveryPending(RuntimeError):
    """Recovery can be retried without discarding the owner's running intent."""


class ListenerLost(RuntimeError):
    """The recorded listener exited, was replaced or closed its port.

    The route is withdrawn at once, but the owner's running intent is kept, as
    for any other definite check failure, so restore-after-restart and the next
    clean check can still bring the preview back."""


# Failures that stop a preview and say why. Each stays a ValueError, so the
# fail-closed handling and the error text are unchanged; `reason` only labels it.
class ServiceGone(ValueError):
    """The managed service is not running. Broker.service_gone_cause decides why."""


class ConfigChanged(ValueError):
    reason = 'config_changed'


class ProcessChanged(ValueError):
    reason = 'process_changed'


class WorkspaceUnavailable(ValueError):
    reason = 'workspace_unavailable'


def _libproc_socket_types():
    """ctypes mirrors of the <sys/proc_info.h> socket structures, built once.

    Declared field by field from the macOS SDK header, never as raw offsets.
    The layout is ABI-sensitive, so callers also check the size the kernel
    reports, and the broker grants timeout grace only to a route whose
    in-process check agreed with lsof at its last full verification."""
    cached = getattr(_libproc_socket_types, 'cached', None)
    if cached:
        return cached
    import ctypes
    c = ctypes

    class ProcFDInfo(c.Structure):
        _fields_ = [('proc_fd', c.c_int32), ('proc_fdtype', c.c_uint32)]

    class ProcFileInfo(c.Structure):
        _fields_ = [('fi_openflags', c.c_uint32), ('fi_status', c.c_uint32), ('fi_offset', c.c_int64),
                    ('fi_type', c.c_int32), ('fi_guardflags', c.c_uint32)]

    class VInfoStat(c.Structure):
        _fields_ = [('vst_dev', c.c_uint32), ('vst_mode', c.c_uint16), ('vst_nlink', c.c_uint16),
                    ('vst_ino', c.c_uint64), ('vst_uid', c.c_uint32), ('vst_gid', c.c_uint32),
                    ('vst_atime', c.c_int64), ('vst_atimensec', c.c_int64), ('vst_mtime', c.c_int64),
                    ('vst_mtimensec', c.c_int64), ('vst_ctime', c.c_int64), ('vst_ctimensec', c.c_int64),
                    ('vst_birthtime', c.c_int64), ('vst_birthtimensec', c.c_int64), ('vst_size', c.c_int64),
                    ('vst_blocks', c.c_int64), ('vst_blksize', c.c_int32), ('vst_flags', c.c_uint32),
                    ('vst_gen', c.c_uint32), ('vst_rdev', c.c_uint32), ('vst_qspare', c.c_int64 * 2)]

    class SockbufInfo(c.Structure):
        _fields_ = [('sbi_cc', c.c_uint32), ('sbi_hiwat', c.c_uint32), ('sbi_mbcnt', c.c_uint32),
                    ('sbi_mbmax', c.c_uint32), ('sbi_lowat', c.c_uint32), ('sbi_flags', c.c_short),
                    ('sbi_timeo', c.c_short)]

    class In4In6Addr(c.Structure):
        _fields_ = [('i46a_pad32', c.c_uint32 * 3), ('i46a_addr4', c.c_uint8 * 4)]

    class In6Addr(c.Union):  # struct in6_addr: a union of 8-, 16- and 32-bit views
        _fields_ = [('s6_addr', c.c_uint8 * 16), ('s6_addr32', c.c_uint32 * 4)]

    class InAddr46(c.Union):
        _fields_ = [('ina_46', In4In6Addr), ('ina_6', In6Addr)]

    class InV4(c.Structure):
        _fields_ = [('in4_tos', c.c_ubyte)]

    class InV6(c.Structure):
        _fields_ = [('in6_hlim', c.c_uint8), ('in6_cksum', c.c_int), ('in6_ifindex', c.c_ushort),
                    ('in6_hops', c.c_short)]

    class InSockInfo(c.Structure):
        _fields_ = [('insi_fport', c.c_int), ('insi_lport', c.c_int), ('insi_gencnt', c.c_uint64),
                    ('insi_flags', c.c_uint32), ('insi_flow', c.c_uint32), ('insi_vflag', c.c_uint8),
                    ('insi_ip_ttl', c.c_uint8), ('rfu_1', c.c_uint32), ('insi_faddr', InAddr46),
                    ('insi_laddr', InAddr46), ('insi_v4', InV4), ('insi_v6', InV6)]

    class TcpSockInfo(c.Structure):
        _fields_ = [('tcpsi_ini', InSockInfo), ('tcpsi_state', c.c_int), ('tcpsi_timer', c.c_int * 4),
                    ('tcpsi_mss', c.c_int), ('tcpsi_flags', c.c_uint32), ('rfu_1', c.c_uint32),
                    ('tcpsi_tp', c.c_uint64)]

    sock_maxaddrlen = 255  # SOCK_MAXADDRLEN; larger than struct sockaddr_un (106)

    class UnSockInfo(c.Structure):
        _fields_ = [('unsi_conn_so', c.c_uint64), ('unsi_conn_pcb', c.c_uint64),
                    ('unsi_addr', c.c_char * sock_maxaddrlen), ('unsi_caddr', c.c_char * sock_maxaddrlen)]

    class NdrvInfo(c.Structure):
        _fields_ = [('ndrvsi_if_family', c.c_uint32), ('ndrvsi_if_unit', c.c_uint32),
                    ('ndrvsi_if_name', c.c_char * 16)]  # IF_NAMESIZE

    class KernEventInfo(c.Structure):
        _fields_ = [('kesi_vendor_code_filter', c.c_uint32), ('kesi_class_filter', c.c_uint32),
                    ('kesi_subclass_filter', c.c_uint32)]

    class KernCtlInfo(c.Structure):
        _fields_ = [('kcsi_id', c.c_uint32), ('kcsi_reg_unit', c.c_uint32), ('kcsi_flags', c.c_uint32),
                    ('kcsi_recvbufsize', c.c_uint32), ('kcsi_sendbufsize', c.c_uint32),
                    ('kcsi_unit', c.c_uint32), ('kcsi_name', c.c_char * 96)]  # MAX_KCTL_NAME

    class VsockInfo(c.Structure):
        _fields_ = [('local_cid', c.c_uint32), ('local_port', c.c_uint32), ('remote_cid', c.c_uint32),
                    ('remote_port', c.c_uint32)]

    class SockProto(c.Union):
        _fields_ = [('pri_in', InSockInfo), ('pri_tcp', TcpSockInfo), ('pri_un', UnSockInfo),
                    ('pri_ndrv', NdrvInfo), ('pri_kern_event', KernEventInfo), ('pri_kern_ctl', KernCtlInfo),
                    ('pri_vsock', VsockInfo)]

    class SocketInfo(c.Structure):
        _fields_ = [('soi_stat', VInfoStat), ('soi_so', c.c_uint64), ('soi_pcb', c.c_uint64),
                    ('soi_type', c.c_int), ('soi_protocol', c.c_int), ('soi_family', c.c_int),
                    ('soi_options', c.c_short), ('soi_linger', c.c_short), ('soi_state', c.c_short),
                    ('soi_qlen', c.c_short), ('soi_incqlen', c.c_short), ('soi_qlimit', c.c_short),
                    ('soi_timeo', c.c_short), ('soi_error', c.c_ushort), ('soi_oobmark', c.c_uint32),
                    ('soi_rcv', SockbufInfo), ('soi_snd', SockbufInfo), ('soi_kind', c.c_int),
                    ('rfu_1', c.c_uint32), ('soi_proto', SockProto)]

    class SocketFDInfo(c.Structure):
        _fields_ = [('pfi', ProcFileInfo), ('psi', SocketInfo)]

    _libproc_socket_types.cached = (ProcFDInfo, SocketFDInfo)
    return _libproc_socket_types.cached


def loopback_listener_port(info, size):
    """Decide one socket_fdinfo from proc_pidfdinfo, without touching the kernel.

    Returns (port, set SO_REUSEPORT) for a TCP socket in the LISTEN state on
    IPv4 127.0.0.1, and None for anything else, including an accepted or other
    connected socket on the same port. Raises OSError when the kernel's
    structure size differs from the declared layout."""
    import ctypes
    if size != ctypes.sizeof(info):
        raise OSError('Unexpected socket_fdinfo layout')
    socket_info = info.psi
    if socket_info.soi_kind != 2:  # SOCKINFO_TCP
        return None
    tcp = socket_info.soi_proto.pri_tcp
    address = tcp.tcpsi_ini
    if (tcp.tcpsi_state != 1  # TSI_S_LISTEN
            or not address.insi_vflag & 0x1  # INI_IPV4
            or bytes(address.insi_laddr.ina_46.i46a_addr4) != bytes([127, 0, 0, 1])):
        return None
    return socket.ntohs(address.insi_lport & 0xffff), bool(socket_info.soi_options & 0x0200)  # SO_REUSEPORT


def _broker_messages(path=None):
    """Every fixed message this module raises or records. Computed from the source so a
    new message is covered without a list to maintain; f-strings never match.

    A source that cannot be read yields an empty set, so the broker still imports and
    every error publishes as its exception type name, the safe direction."""
    names = 'ValueError|ServiceGone|ConfigChanged|ProcessChanged|WorkspaceUnavailable|RecoveryPending|ListenerLost'
    try:
        source = Path(path or __file__).read_text(encoding='utf-8')
    except (OSError, ValueError):
        return frozenset()
    found = set(re.findall(r"\b(?:" + names + r")\('([^'{}\\]+)'\)", source))
    found.update(re.findall(r"entry\['error'\] = '([^'{}\\]+)'", source))
    found.add('Checks timed out; route withdrawn until a check succeeds')
    return frozenset(found)


BROKER_MESSAGES = _broker_messages()


def public_error(message):
    """An error fit to publish: a fixed broker message, the timeout count, or a type name.

    Older ledgers may still hold str() of a library error, which can echo its input."""
    if not isinstance(message, str):
        return 'Error'
    if message in BROKER_MESSAGES or UNVERIFIED_MESSAGE.fullmatch(message) or IDENTIFIER.fullmatch(message):
        return message
    return 'Error'


class Runtime:
    def __init__(self, config):
        self.c = config
        self.base = [config['docker'], '--context', config['context']]

    def command(self, args, timeout=12):
        result = subprocess.run(args, capture_output=True, timeout=timeout, check=True,
                                # The signed macOS Tailscale binary selects its
                                # CLI entry point only when TERM is present.
                                env={'PATH': '/usr/bin:/bin:/usr/local/bin', 'HOME': str(Path.home()), 'TERM': 'dumb'})
        if len(result.stdout) > 4 * 1024 * 1024:
            raise ValueError('Runtime response too large')
        return result.stdout.decode()

    def docker(self, args):
        return self.command(self.base + args)

    def cli(self, args):
        # Never run an agent-writable helper as administrator. Only the installed CLI,
        # with privileges removed, talks to the current daemon.
        return json.loads(self.docker(['exec', self.c['container'], '/usr/bin/setpriv', '--reuid=paseo', '--regid=paseo', '--init-groups', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '/usr/local/bin/paseo', *args, '--json']))

    def ts(self, args):
        return self.docker(['exec', self.c['container'], '/usr/local/bin/tailscale', '--socket=/run/tailscale/tailscaled.sock', *args])

    def daemon_identity(self):
        # A PID alone can be reused, including across a container restart.
        code = r"""
const fs=require('node:fs');const path=require('node:path');const found=[];
const crypto=require('node:crypto');const replaced=new Map();
// A program whose file was replaced keeps running the old inode, shown as "(deleted)". Accept it
// only when the file now at that path is byte-identical; anything else fails closed.
const exe=pid=>{const link=fs.readlinkSync(`/proc/${pid}/exe`);if(!link.endsWith(' (deleted)'))return fs.realpathSync(`/proc/${pid}/exe`);
  const current=fs.realpathSync(link.slice(0,-' (deleted)'.length));const key=`${link}:${fs.statSync(`/proc/${pid}/exe`).ino}`;
  const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(!replaced.has(key))replaced.set(key,digest(`/proc/${pid}/exe`)===digest(current));
  if(!replaced.get(key))process.exit(1);
  return current;};
const home=process.env.PASEO_HOME||path.join(require('node:os').homedir(),'.paseo');
const ownerFile=path.join(home,'paseo.pid');
const ownerText=fs.readFileSync(ownerFile,'utf8');
const owner=JSON.parse(ownerText).pid;
if(!Number.isSafeInteger(owner)||owner<=0)process.exit(1);
const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
const start=pid=>{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];};
const owned=status=>{const ids=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m);return ids&&ids.slice(1).every(id=>Number(id)===process.getuid());};
const ownerStart=start(owner);
if(!owned(fs.readFileSync(`/proc/${owner}/status`,'utf8')))process.exit(1);
const markerFile=path.join(home,'managed-supervisor.json');
let markerText,selected,entry,node,marker;
if(fs.existsSync(markerFile)){
  markerText=fs.readFileSync(markerFile,'utf8');marker=JSON.parse(markerText);
  if(marker.version!==1||marker.pid!==owner||!path.isAbsolute(marker.root)||!path.isAbsolute(marker.link)||path.dirname(marker.link)!==marker.root||fs.realpathSync(marker.root)!==marker.root)process.exit(1);
  const env=fs.readFileSync(`/proc/${owner}/environ`,'utf8').split('\0');
  if(!env.includes(`PASEO_MANAGED_RELEASE_LINK=${marker.link}`)||!env.includes(`PASEO_MANAGED_RELEASE_ROOT=${marker.root}`))process.exit(1);
  selected=fs.realpathSync(marker.link);
  if(!selected.startsWith(marker.root+path.sep))process.exit(1);
  entry=path.join(selected,'packages/server/dist/server/server/daemon-worker.js');
  if(fs.realpathSync(entry)!==entry)process.exit(1);
  node=exe(owner);
}
for(const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p))){
  try{
    const ticks=start(pid);
    if(!/^\d+$/.test(ticks))process.exit(1);
    const status=fs.readFileSync(`/proc/${pid}/status`,'utf8');
    if(!owned(status))continue;
    const parent=Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
    if(marker){
      if(parent!==owner)continue;
      const argv=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
      if(argv.pop()!==''||argv.length!==2||argv[1]!==entry||fs.realpathSync(argv[0])!==node||exe(pid)!==node)continue;
    }else if(!/^Name:\s+Paseo Daemon$/m.test(status)||(Number(pid)!==owner&&parent!==owner))continue;
    found.push({pid,ticks,value:`${boot}:${pid}:${ticks}`});
  }catch(e){if(!['ENOENT','EACCES','ESRCH'].includes(e.code))throw e;}
}
if(found.length!==1)process.exit(1);
if(fs.readFileSync(ownerFile,'utf8')!==ownerText||start(owner)!==ownerStart||start(found[0].pid)!==found[0].ticks||fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()!==boot)process.exit(1);
if(marker&&(fs.readFileSync(markerFile,'utf8')!==markerText||fs.realpathSync(marker.link)!==selected))process.exit(1);
process.stdout.write(found[0].value);
"""
        return self.docker(['exec', '--user', 'paseo', self.c['container'], '/usr/local/bin/node', '-e', code]).strip()

    def verify_node(self):
        """The node is still the one this broker was pinned to."""
        status = json.loads(self.ts(['status', '--json']))
        if status['Self']['ID'] != self.c['nodeId'] or status['Self']['DNSName'].rstrip('.') != self.c['hostname']:
            raise ValueError('Tailscale identity changed; administrator review required')

    def preflight(self):
        self.verify_node()
        netmap = json.loads(self.ts(['debug', 'netmap']))
        if digest(netmap.get('PacketFilter')) != self.c['packetFilterHash']:
            raise ValueError('Tailnet access scope changed; administrator review required')
        self.publication()

    def publication(self):
        value = json.loads(self.ts(['serve', 'status', '--json']))
        if any(value.get('AllowFunnel', {}).values()):
            raise ValueError('Unexpected Funnel state; administrator review required')
        return value

    def host_workspace(self, cwd):
        path = Path(cwd)
        if not path.is_absolute() or '..' in path.parts:
            raise ValueError('Invalid container workspace path')
        mappings = dict(self.c.get('hostPathMappings', {}))
        mappings['/home/paseo'] = str(Path(self.c['deployment']) / 'data/home')
        for container_root in sorted(mappings, key=len, reverse=True):
            host_root = Path(mappings[container_root])
            if not host_root.is_absolute() or '..' in host_root.parts:
                raise ValueError('Invalid administrator host mapping')
            if cwd == container_root or cwd.startswith(container_root.rstrip('/') + '/'):
                return host_root / path.relative_to(container_root)
        if 'hostPathMappings' not in self.c:
            return path
        raise ValueError('Workspace has no verified host bind mapping')

    def workspace_path_allowed(self, cwd):
        policy = self.c.get('workspacePolicy', 'approved-roots')
        if policy == 'registered':
            # Registration replaces per-directory grants, never host mount verification.
            if 'hostPathMappings' not in self.c:
                raise ValueError('Registered workspace policy requires verified host bind mappings')
            return True
        if policy != 'approved-roots':
            raise ValueError('Unsupported workspace policy')
        return any(cwd == root or cwd.startswith(root.rstrip('/') + '/') for root in self.c['allowedRoots'])

    def canonical_workspace_cwd(self, cwd):
        # A Host-path alias grants no new access. Prove that Dev resolves it to
        # the same bind destination used for policy, configuration and ledger checks.
        path = Path(cwd)
        if not path.is_absolute() or '..' in path.parts or str(path) != cwd:
            raise ValueError('Invalid container workspace path')
        mappings = self.c.get('hostPathMappings', {})
        if any(cwd == root or cwd.startswith(root.rstrip('/') + '/') for root in (*mappings, '/home/paseo')):
            return cwd
        candidates = []
        for container_root, host_root in mappings.items():
            if cwd != host_root and not cwd.startswith(host_root.rstrip('/') + '/'):
                continue
            for root in (container_root, host_root):
                if not Path(root).is_absolute() or '..' in Path(root).parts or str(Path(root)) != root:
                    raise ValueError('Invalid administrator host mapping')
            canonical = str(Path(container_root) / path.relative_to(host_root))
            candidates.append((container_root, host_root, canonical))
        if not candidates:
            return cwd
        if len(candidates) != 1:
            raise ValueError('Workspace has no unambiguous verified host bind alias')
        container_root, host_root, canonical = candidates[0]
        if self.host_workspace(canonical) != path:
            raise ValueError('Workspace alias conflicts with administrator mapping')
        mounts = json.loads(self.docker(['inspect', '--format', '{{json .Mounts}}', self.c['container']]))
        matching = [m for m in mounts if m.get('Destination') == container_root]
        if len(matching) != 1 or matching[0].get('Type') != 'bind' or matching[0].get('Source') != host_root:
            raise ValueError('Workspace alias bind differs from administrator mapping')
        for mount in mounts:
            destination = mount.get('Destination', '')
            if (destination.startswith(container_root.rstrip('/') + '/') and
                    (canonical == destination or canonical.startswith(destination.rstrip('/') + '/'))):
                raise ValueError('Workspace alias is shadowed by a nested mount')
        resolved = self.docker(['exec', '--user', 'paseo', self.c['container'],
                                '/usr/bin/readlink', '-e', '--', cwd]).rstrip('\n')
        if resolved != canonical:
            raise ValueError('Workspace alias does not resolve to its verified mounted path')
        return canonical

    def current(self, workspace, service):
        workspaces = self.cli(['workspace', 'ls'])
        match = next((w for w in workspaces if w['workspaceId'] == workspace), None)
        if not match or match.get('archivedAt') or match.get('isolation') not in ('local', 'worktree'):
            raise WorkspaceUnavailable('Unknown, archived or unsupported workspace')
        registered_cwd = match['cwd']
        cwd = self.canonical_workspace_cwd(registered_cwd)
        if not self.workspace_path_allowed(cwd):
            raise ValueError('Workspace is outside administrator policy')
        approved = self.c.get('approvedWorkspaces', {})
        if workspace in approved and approved[workspace] != cwd:
            raise ValueError('Approved workspace moved')
        if self.c.get('workspacePolicy', 'approved-roots') != 'registered' and match['isolation'] == 'worktree' and approved.get(workspace) != cwd:
            raise ValueError('Worktree requires explicit administrator approval')
        path = self.host_workspace(cwd)
        cfg = project_config(path)
        definition = cfg.get('scripts', {}).get(service)
        scripts = self.cli(['script', 'ls', '--workspace', workspace])
        entry = next((s for s in scripts if s['scriptName'] == service), None)
        if not entry or entry['type'] != 'service' or not isinstance(definition, dict) or definition.get('type') != 'service':
            raise ValueError('Unknown registered service')
        if registered_cwd != cwd and self.canonical_workspace_cwd(registered_cwd) != cwd:
            raise ValueError('Workspace alias changed during verification')
        return {**entry, 'cwd': cwd, 'fingerprint': digest(definition), 'workspaceId': workspace, 'service': service}

    def registered_ports(self):
        ports = set()
        seen = set()
        for workspace in self.cli(['workspace', 'ls'])[:256]:
            cwd = workspace['cwd']
            if cwd in seen:
                continue
            seen.add(cwd)
            # A workspace whose path is missing, symlinked or otherwise unsafe
            # cannot be served (current() rejects it), so it holds no ports.
            # Skip it rather than failing every other workspace's reservation.
            try:
                canonical = self.canonical_workspace_cwd(cwd)
                if not self.workspace_path_allowed(canonical):
                    continue
                cfg = project_config(self.host_workspace(canonical))
            except (OSError, ValueError, subprocess.SubprocessError):
                continue
            for definition in cfg.get('scripts', {}).values():
                if isinstance(definition, dict) and definition.get('type') == 'service' and type(definition.get('port')) is int:
                    ports.add(definition['port'])
        return ports

    def daemon_worker(self):
        # Container identities carry kernel ticks, not wall time, so a stop here is
        # never attributed to a restart. The owner sees the stop time with no cause.
        return None

    def lifecycle(self, operation, entry):
        return self.cli(['script', operation, entry['service'], '--workspace', entry['workspaceId']])

    def listener_identity(self, port, terminal):
        # Prove that the loopback listener belongs to the managed terminal, not
        # merely that some HTTP process has reused a formerly allocated port.
        code = r"""
const fs=require('node:fs');const port=Number(process.argv[1]);const terminal=process.argv[2];
const sockets=fs.readFileSync('/proc/net/tcp','utf8').trim().split('\n').slice(1).map(l=>l.trim().split(/\s+/)).filter(a=>a[3]==='0A'&&parseInt(a[1].split(':')[1],16)===port&&['0100007F','00000000'].includes(a[1].split(':')[0])).map(a=>'socket:['+a[9]+']');
const found=[];const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
for(const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).slice(0,8192))try{
 const fds=fs.readdirSync('/proc/'+pid+'/fd');
 if(!fds.some(fd=>{try{return sockets.includes(fs.readlinkSync('/proc/'+pid+'/fd/'+fd))}catch{return false}}))continue;
 const env=fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0');
 if(!env.includes('PASEO_TERMINAL_ID='+terminal))throw Error('Listener is not owned by the managed terminal');
 const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');found.push(boot+':'+pid+':'+stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]);
}catch(e){if(e.message==='Listener is not owned by the managed terminal')throw e;}
if(found.length!==1)throw Error('Expected exactly one managed loopback listener');console.log(found[0]);
"""
        return self.docker(['exec', '--user', 'paseo', self.c['container'], '/usr/local/bin/node', '-e', code, str(port), terminal]).strip()

    def backend_ready(self, port):
        # Fixed program, numeric argument only. Loopback is the only target.
        code = "fetch('http://127.0.0.1:'+process.argv[1]+'/',{signal:AbortSignal.timeout(2500),redirect:'manual'}).then(r=>{process.exit(r.status>=200&&r.status<400?0:1)}).catch(()=>process.exit(1))"
        self.docker(['exec', '--user', 'paseo', self.c['container'], '/usr/local/bin/node', '-e', code, str(port)])

    def free(self, port, retained=False):
        code = "const s=require('node:net').createServer();s.on('error',()=>process.exit(1));s.listen(Number(process.argv[1]),'0.0.0.0',()=>s.close());"
        self.docker(['exec', '--user', 'paseo', self.c['container'], '/usr/local/bin/node', '-e', code, str(port)])

    def set_mapping(self, port, backend):
        self.ts(['serve', '--bg', f'--https={port}', f'http://127.0.0.1:{backend}'])

    def remove_mapping(self, port):
        self.ts(['serve', f'--https={port}', 'off'])

    def verify(self, url):
        self.command(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--max-time', '8', '--output', '/dev/null', url])

    def listener_unchanged(self, entry):
        """Recheck the recorded listener without a subprocess, for timeout grace.

        Every container identity check needs `docker exec`, the call that times
        out under load, so the container runtime cannot vouch for the listener
        and gives no grace: a timeout withdraws the route as before."""
        return False

    def in_process_check_agrees(self, port, listener):
        """Whether the in-process port check confirms what the full check just proved."""
        return False


class NativeRuntime(Runtime):
    """Same broker contract for the logged-in macOS user's native daemon."""

    def __init__(self, config):
        self.c = config

    def cli(self, args):
        value = json.loads(self.command([*self.c['cliCommand'], '--home', self.c['daemonHome'], *args, '--json'], timeout=20))
        if isinstance(value, dict) and 'error' in value:
            raise ValueError('Native daemon CLI refused the preview operation')
        return value

    def ts(self, args):
        # Previews may be published by a dedicated Tailscale node with its own daemon, so
        # preview links never share a hostname with the interface. That daemon is
        # addressed by socket; without one, the default system daemon is used.
        socket = self.c.get('tailscaleSocket')
        return self.command([self.c['tailscale'], *(['--socket=' + socket] if socket else []), *args])

    def canonical_workspace_cwd(self, cwd):
        return cwd

    def host_workspace(self, cwd):
        path = Path(cwd)
        if not path.is_absolute() or '..' in path.parts:
            raise ValueError('Invalid native workspace path')
        descriptor = safe_dir(path)
        os.close(descriptor)
        return path

    def workspace_path_allowed(self, cwd):
        policy = self.c.get('workspacePolicy', 'approved-roots')
        if policy == 'registered':
            return True
        if policy != 'approved-roots':
            raise ValueError('Unsupported workspace policy')
        return any(cwd == root or cwd.startswith(root.rstrip('/') + '/') for root in self.c['allowedRoots'])

    def process_identity(self, pid):
        if type(pid) is not int or pid <= 0:
            raise ValueError('Invalid process identity')
        # macOS exposes microsecond process birth times through libproc. Do not
        # use ps lstart: second precision can confuse a rapidly reused PID.
        import ctypes
        class BSDInfo(ctypes.Structure):
            _fields_ = [('flags', ctypes.c_uint32), ('status', ctypes.c_uint32),
                       ('xstatus', ctypes.c_uint32), ('pid', ctypes.c_uint32),
                       ('ppid', ctypes.c_uint32), ('uid', ctypes.c_uint32),
                       ('gid', ctypes.c_uint32), ('ruid', ctypes.c_uint32),
                       ('rgid', ctypes.c_uint32), ('svuid', ctypes.c_uint32),
                       ('svgid', ctypes.c_uint32), ('rfu', ctypes.c_uint32),
                       ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32),
                       ('nfiles', ctypes.c_uint32), ('pgid', ctypes.c_uint32),
                       ('pjobc', ctypes.c_uint32), ('tdev', ctypes.c_uint32),
                       ('tpgid', ctypes.c_uint32), ('nice', ctypes.c_int32),
                       ('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64)]
        info = BSDInfo()
        libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        probe = libproc.proc_pidinfo
        probe.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        probe.restype = ctypes.c_int
        if probe(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
            raise ValueError('Process identity unavailable')
        if info.pid != pid or any(uid != os.getuid() for uid in (info.uid, info.ruid, info.svuid)):
            raise ValueError('Process is not owned by the native user')
        return {'pid': pid, 'parent': info.ppid, 'birth': f'{info.start_sec}:{info.start_usec}'}

    def listener_pid(self, port):
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError('Invalid listener port')
        result = self.command(['/usr/sbin/lsof', '-nP', '-a', f'-iTCP:{port}', '-sTCP:LISTEN', '-Fpn'])
        pids = set()
        addresses = []
        for line in result.splitlines():
            if line.startswith('p') and line[1:].isdigit():
                pids.add(int(line[1:]))
            elif line.startswith('n'):
                addresses.append(line[1:])
        if len(pids) != 1 or not addresses or any(address != f'127.0.0.1:{port}' for address in addresses):
            raise ValueError('Expected exactly one IPv4 loopback listener')
        return next(iter(pids))

    def daemon_identity(self):
        lock_path = Path(self.c['daemonHome']) / 'paseo.pid'
        lock = safe_read(lock_path)
        match = re.fullmatch(r'127\.0\.0\.1:([0-9]+)', lock.get('listen', ''))
        if not match:
            raise ValueError('Native daemon must have a pinned loopback endpoint')
        owner = self.process_identity(lock['pid'])
        worker = self.process_identity(self.listener_pid(int(match[1])))
        if worker['pid'] != owner['pid'] and worker['parent'] != owner['pid']:
            raise ValueError('Native daemon listener is not owned by its supervisor')
        if safe_read(lock_path) != lock or self.process_identity(owner['pid']) != owner:
            raise ValueError('Native daemon changed during identity verification')
        return f"{worker['pid']}:{worker['birth']}"

    def daemon_worker(self):
        """The serving daemon worker and its start time, to explain a stop.

        The worker, not the supervisor's pid file, is used: a worker restart inside
        the same supervisor also closes terminals and keeps the pid file's time."""
        identity = self.daemon_identity()
        seconds, microseconds = identity.split(':')[1:3]
        return {'identity': identity, 'startedAt': int(seconds) + int(microseconds) / 1e6}

    def listener_identity(self, port, terminal):
        if not isinstance(terminal, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', terminal):
            raise ValueError('Invalid managed terminal identity')
        pid = self.listener_pid(port)
        before = self.process_identity(pid)
        if self.terminal_environment(pid) != terminal:
            raise ValueError('Listener is not owned by the managed terminal')
        if self.listener_pid(port) != pid or self.process_identity(pid) != before:
            raise ValueError('Listener changed during identity verification')
        return f"{pid}:{before['birth']}"

    def listener_unchanged(self, entry):
        """Recheck the recorded listener in process, without lsof or curl.

        libproc and sysctl answer from the kernel without spawning anything, so
        this still works when subprocess checks time out. It proves the process
        that passed the last full check is alive, is the same process (microsecond
        birth time defeats PID reuse) and still carries the managed terminal ID.
        It cannot prove that process still holds the port; see the PR for #358."""
        recorded = entry.get('listener')
        if not isinstance(recorded, str) or not entry.get('terminal') or type(entry.get('backend')) is not int:
            return False
        pid, _, birth = recorded.partition(':')
        if not pid.isdigit() or not birth:
            return False
        pid = int(pid)
        try:
            alive = self.process_identity(pid)
        except ValueError:
            # Exited, or the PID now belongs to someone else: the old process is gone.
            raise ListenerLost('Backend listener process exited') from None
        if alive['birth'] != birth:
            raise ListenerLost('Backend listener process was replaced')
        try:
            terminal = self.terminal_environment(pid)
        except ValueError:
            raise ListenerLost('Backend listener environment unavailable') from None
        if terminal != entry['terminal']:
            # A live process now claims another terminal: an identity change.
            raise ValueError('Listener is not owned by the managed terminal')
        if not self.loopback_listener_held(pid, entry['backend']):
            raise ListenerLost('Backend listener no longer holds its loopback port')
        return True

    def in_process_check_agrees(self, port, listener):
        """Self-check run at every full verification, right after lsof proved the listener.

        The in-process check must say yes for the proven port and no for a port
        the process does not listen on, so a check that always says yes never
        agrees. Any error, including an unevaluable probe, means no agreement."""
        pid, _, _ = str(listener).partition(':')
        try:
            if not pid.isdigit():
                return False
            pid = int(pid)
            listening = self.loopback_listening_ports(pid)
            # Deterministic: the first port after the proven one that this process
            # does not hold on loopback, wrapping round below it.
            probe = next((candidate for candidate in (*range(port + 1, 65536), *range(1, port))
                          if candidate not in listening), None)
            if probe is None:
                return False
            return self.loopback_listener_held(pid, port) is True and self.loopback_listener_held(pid, probe) is False
        except Exception:
            return False  # An error or an unevaluable layout means no grace later.

    def loopback_listener_held(self, pid, port):
        """Whether pid holds a TCP socket listening on exactly 127.0.0.1:port.

        Returns False when pid holds no such listener; a wildcard or IPv6 bind
        on the port does not count, because the route proxies to 127.0.0.1.
        Raises OSError when it cannot vouch: the kernel returned a structure of
        another size, or the listener set SO_REUSEPORT, which would let another
        process bind the same address and port beside it."""
        listening = self.loopback_listening_ports(pid)
        if listening.get(port):
            raise OSError('Shared-port listener; cannot vouch for the port')
        return port in listening

    def loopback_listening_ports(self, pid):
        """Map each port pid listens on at 127.0.0.1 to whether it set SO_REUSEPORT.

        Reads the process's descriptors through libproc, with no subprocess."""
        import ctypes
        ProcFDInfo, SocketFDInfo = _libproc_socket_types()
        libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        listing = libproc.proc_pidinfo
        listing.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        listing.restype = ctypes.c_int
        detail = libproc.proc_pidfdinfo
        detail.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        detail.restype = ctypes.c_int
        needed = listing(pid, 1, 0, None, 0)  # PROC_PIDLISTFDS
        if needed <= 0:
            raise OSError('Listener descriptors unavailable')
        count = min(needed // ctypes.sizeof(ProcFDInfo) + 16, 65536)
        fds = (ProcFDInfo * count)()
        written = listing(pid, 1, 0, fds, ctypes.sizeof(fds))
        if written <= 0 or written % ctypes.sizeof(ProcFDInfo):
            raise OSError('Listener descriptors unavailable')
        listening = {}
        for fd in fds[:written // ctypes.sizeof(ProcFDInfo)]:
            if fd.proc_fdtype != 2:  # PROX_FDTYPE_SOCKET
                continue
            info = SocketFDInfo()
            size = detail(pid, fd.proc_fd, 3, ctypes.byref(info), ctypes.sizeof(info))  # PROC_PIDFDSOCKETINFO
            if size <= 0:
                continue  # Closed since the listing.
            found = loopback_listener_port(info, size)
            if found is not None:
                port, shared = found
                listening[port] = listening.get(port, False) or shared
        return listening

    def terminal_environment(self, pid):
        # Read KERN_PROCARGS2 directly, separating argv from env. Parsing ps
        # output would let a command-line argument impersonate an env binding.
        import ctypes
        import struct
        libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        mib = (ctypes.c_int * 3)(1, 49, pid)
        argument_limit = os.sysconf('SC_ARG_MAX')
        if not 0 < argument_limit <= 2 * 1024 * 1024:
            raise ValueError('Unsupported native argument limit')
        size = ctypes.c_size_t(argument_limit)
        buffer = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
            raise ValueError('Listener environment unavailable')
        data = buffer.raw[:size.value]
        argc = struct.unpack_from('i', data)[0]
        if not 0 <= argc <= 65536:
            raise ValueError('Invalid listener argument count')
        offset = data.index(b'\0', 4) + 1
        while offset < len(data) and data[offset] == 0:
            offset += 1
        for _ in range(argc):
            offset = data.index(b'\0', offset) + 1
        # Do not log or persist the buffer: other entries may be credentials.
        matches = [part.split(b'=', 1)[1] for part in data[offset:].split(b'\0')
                   if part.startswith(b'PASEO_TERMINAL_ID=')]
        return matches[0].decode('ascii') if len(matches) == 1 else None

    def backend_ready(self, port):
        self.command(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--max-time', '3',
                      '--output', '/dev/null', f'http://127.0.0.1:{port}/'])

    def free(self, port, retained=False):
        try:
            with socket.socket() as listener:
                listener.bind(('0.0.0.0', port))
        except OSError as error:
            if retained and self.only_retained_tailnet_connections(port):
                return
            raise subprocess.SubprocessError('Port is occupied') from error

    def only_retained_tailnet_connections(self, port):
        # macOS keeps accepted TLS sockets after Serve removes a route. They
        # prevent wildcard bind, even though no listener remains. Only an owned
        # reservation may take this path; fresh reservations still require bind.
        status = json.loads(self.ts(['status', '--json']))['Self']
        if status['ID'] != self.c['nodeId'] or status['DNSName'].rstrip('.') != self.c['hostname']:
            raise ValueError('Tailscale identity changed during port verification')
        addresses = set(status['TailscaleIPs'])
        states = {'ESTABLISHED', 'FIN_WAIT_1', 'FIN_WAIT_2', 'CLOSE_WAIT', 'CLOSING', 'LAST_ACK', 'TIME_WAIT'}
        connections = []
        for line in self.command(['/usr/sbin/netstat', '-an', '-p', 'tcp']).splitlines():
            fields = line.split()
            if len(fields) < 6 or not fields[0].startswith('tcp'):
                continue
            address, separator, local_port = fields[3].rpartition('.')
            if separator and local_port == str(port):
                connections.append((address, fields[5]))
        return bool(connections) and all(address in addresses and state in states for address, state in connections)


def runtime_for(config):
    kind = config.get('runtime', 'container')
    if kind == 'native':
        return NativeRuntime(config)
    if kind == 'container':
        return Runtime(config)
    raise ValueError('Unsupported preview runtime')


class Broker:
    def __init__(self, config, runtime=None, reload_config=None):
        self.c = config
        self.root = Path(config['deployment'])
        self.runtime = runtime or runtime_for(config)
        self.reload_config = reload_config
        self.ledger_path = self.root / 'https-broker-ledger.json'
        self.channel = Path(config['channel'])
        self.ledger = safe_read(self.ledger_path, 2 * 1024 * 1024) if self.ledger_path.exists() else {'entries': {}, 'requests': {}}

    def save(self):
        atomic(self.ledger_path, self.ledger)

    def key(self, r):
        return r['workspaceId'] + '.' + r['service']

    def route(self, entry):
        return {'Handlers': {'/': {'Proxy': f"http://127.0.0.1:{entry['backend']}"}}}

    def address(self, entry):
        return f"{self.c['hostname']}:{entry['frontend']}"

    def remove(self, entry):
        config = self.runtime.publication()
        address = self.address(entry)
        web = config.get('Web', {}).get(address)
        tcp = config.get('TCP', {}).get(str(entry['frontend']))
        if web is None and tcp is None:
            return
        if web != self.route(entry) or tcp != {'HTTPS': True}:
            raise ValueError('Owned mapping changed externally; no mutation performed')
        self.runtime.remove_mapping(entry['frontend'])
        after = self.runtime.publication()
        if address in after.get('Web', {}) or str(entry['frontend']) in after.get('TCP', {}):
            raise ValueError('Mapping removal not confirmed')

    def reserve(self, r, current):
        key = self.key(r)
        existing = self.ledger['entries'].get(key)
        config = self.runtime.publication()  # Funnel check BEFORE every mutation/adoption.
        if existing:
            if r.get('preferredPort', existing['frontend']) != existing['frontend']:
                raise ValueError('Stable reservation differs from requested origin')
            if existing['cwd'] != current['cwd']:
                raise ValueError('Workspace moved; administrator review required')
            return existing
        if len(self.ledger['entries']) >= 32:
            raise ValueError('Reservation limit reached; administrator review required')
        allocated = {e['frontend'] for e in self.ledger['entries'].values() if 'frontend' in e}
        forbidden = set(self.c['reservedPorts']) | allocated | {current.get('port')} | self.runtime.registered_ports()
        ports = [r['preferredPort']] if 'preferredPort' in r else range(self.c['portStart'], self.c['portEnd'] + 1)
        for port in ports:
            if not self.c['portStart'] <= port <= self.c['portEnd'] or port in forbidden or str(port) in config.get('TCP', {}):
                continue
            if any(address.endswith(':' + str(port)) for address in config.get('Web', {})):
                continue
            try:
                self.runtime.free(port)
            except subprocess.SubprocessError:
                continue
            entry = {'workspaceId': r['workspaceId'], 'service': r['service'], 'frontend': port, 'cwd': current['cwd'], 'fingerprint': current['fingerprint'], 'desired': 'stopped', 'stoppedAt': 0}
            self.ledger['entries'][key] = entry
            self.save()
            return entry
        raise ValueError('Requested HTTPS port is reserved, occupied or outside policy')

    def activate(self, entry):
        daemon = self.runtime.daemon_identity() if self.c.get('restoreAfterRestart') else None
        current = self.runtime.current(entry['workspaceId'], entry['service'])
        if current['cwd'] != entry['cwd'] or current['fingerprint'] != entry['fingerprint']:
            raise ConfigChanged('Service configuration identity changed')
        port = current.get('port')
        if current.get('lifecycle') != 'running' or not current.get('terminalId'):
            raise ServiceGone('Managed service stopped; explicit start required')
        # Native macOS allocation can use the full ephemeral range. The private
        # HTTPS reservation range constrains frontends, not loopback backends.
        if type(port) is not int or not 32768 <= port <= 65535 or port in self.c['reservedPorts'] or any(e.get('frontend') == port for e in self.ledger['entries'].values()):
            raise ValueError('Backend allocation conflicts with control plane or frontend')
        if entry.get('terminal') and (entry['terminal'] != current['terminalId'] or entry.get('backend') != port):
            raise ProcessChanged('Service process identity changed; explicit start required')
        entry.update(backend=port, terminal=current['terminalId'])
        self.save()
        self.runtime.backend_ready(port)
        listener = self.runtime.listener_identity(port, current['terminalId'])
        if entry.get('listener') and entry['listener'] != listener:
            raise ProcessChanged('Backend listener process changed; explicit start required')
        entry['listener'] = listener
        self.save()
        # Self-check of the ABI-sensitive in-process check: it must confirm what
        # lsof just proved, or this route gets no timeout grace later.
        agreed = self.runtime.in_process_check_agrees(port, listener) is True
        before = self.runtime.publication()
        address = self.address(entry)
        web = before.get('Web', {}).get(address)
        tcp = before.get('TCP', {}).get(str(entry['frontend']))
        if web is not None or tcp is not None:
            if web != self.route(entry) or tcp != {'HTTPS': True}:
                raise ValueError('Publication conflict; unrelated mapping preserved')
        else:
            self.runtime.free(entry['frontend'], retained=bool(entry.get('mappingIntent')))
            # Ownership is persisted before mutation so a crash is recoverable.
            entry['mappingIntent'] = True
            self.save()
            self.runtime.set_mapping(entry['frontend'], port)
        after = self.runtime.publication()
        if after.get('Web', {}).get(address) != self.route(entry) or after.get('TCP', {}).get(str(entry['frontend'])) != {'HTTPS': True}:
            raise ValueError('HTTPS mapping verification failed')
        url = f'https://{address}/'
        self.runtime.verify(url)
        again = self.runtime.current(entry['workspaceId'], entry['service'])
        if (again['fingerprint'], again.get('terminalId'), again.get('port'), again.get('lifecycle')) != (entry['fingerprint'], entry['terminal'], port, 'running'):
            raise ProcessChanged('Service changed during verification')
        if daemon is not None:
            if self.runtime.daemon_identity() != daemon:
                self.remove_then_raise(entry, RecoveryPending('Daemon changed during verification'))
            entry['daemon'] = daemon
            entry.pop('recovery', None)
        for stale in ('error', 'misses', 'removalPending', 'needsReview', 'stopReason', 'restartedAt'):
            entry.pop(stale, None)
        if 'daemonWorker' not in entry:
            # Recorded once per start: any later daemon change makes the next check
            # fail with ServiceGone, so this is the daemon the preview last ran under.
            worker = self.observed_daemon_worker()
            if worker:
                entry['daemonWorker'] = worker
        # Only a full verification opens a timeout grace window. A remembered
        # "ready" from an earlier run never does once this time is too old.
        entry.update(status='ready', url=url, verifiedAt=time.time(), inProcessCheckAgreed=agreed)
        self.save()
        return {'status': 'ready', 'url': url, 'frontendPort': entry['frontend'], 'backendPort': port}

    def restore_after_restart(self, entry):
        if not self.c.get('restoreAfterRestart') or not entry.get('daemon'):
            return
        daemon = self.runtime.daemon_identity()
        if daemon == entry['daemon']:
            return
        current = self.runtime.current(entry['workspaceId'], entry['service'])
        if current['cwd'] != entry['cwd'] or current['fingerprint'] != entry['fingerprint']:
            raise ConfigChanged('Service configuration identity changed')
        recovery = entry.get('recovery', {})
        if recovery.get('daemon') != daemon:
            recovery = {'daemon': daemon, 'attempts': 0, 'retryAt': 0}
        if current['lifecycle'] == 'running':
            if not recovery.get('terminal') or current.get('terminalId') != recovery['terminal']:
                raise ProcessChanged('Unrecognized service after daemon restart; explicit start required')
            return
        # Remove the stale route before allowing the daemon to allocate a new backend.
        try:
            self.remove(entry)
        except subprocess.SubprocessError:
            entry['removalPending'] = True
            self.save()
            raise RecoveryPending('Removing the stale route after a daemon restart is pending') from None
        if recovery['attempts'] >= 3:
            raise RecoveryPending('Recovery failed three times; explicit start required')
        if time.time() < recovery['retryAt']:
            raise RecoveryPending('Waiting before retrying preview recovery')
        recovery.update(attempts=recovery['attempts'] + 1, retryAt=time.time() + 30 * (2 ** recovery['attempts']))
        entry.update(recovery=recovery, status='pending')
        entry.pop('url', None)
        self.save()
        atomic(self.channel / 'origins' / (self.key(entry) + '.json'),
               {'origin': f'https://{self.address(entry)}', 'workspaceId': entry['workspaceId'], 'service': entry['service']}, mode=0o644)
        started = self.runtime.lifecycle('start', current)
        if self.runtime.daemon_identity() != daemon:
            raise RecoveryPending('Daemon changed while starting preview')
        terminal = started.get('terminalId')
        if not terminal or started.get('lifecycle') != 'running':
            raise RecoveryPending('Preview start did not return a running terminal')
        # Only the acknowledged managed start may replace the old process identity.
        recovery['terminal'] = terminal
        entry.update(terminal=terminal, backend=started['port'])
        entry.pop('listener', None)
        self.save()

    def handle(self, r):
        now = time.time()
        validate(r, now)
        key = self.key(r)
        entry = self.ledger['entries'].get(key)
        if entry and r['operation'] in ('start', 'restart') and r['createdAt'] <= entry.get('stoppedAt', 0):
            raise ValueError('Start predates explicit stop; submit a new request')
        if r['operation'] == 'status':
            if not entry:
                return {'status': 'failed', 'error': 'No HTTPS reservation'}
            if entry['desired'] == 'stopped':
                return {'status': 'stopped', 'frontendPort': entry.get('frontend')}
            try:
                return self.activate(entry)
            except Exception as error:
                if not entry.get('backend'):
                    raise
                # Same rule as reconcile(), so the two paths cannot drift apart.
                outcome = self.settle_failure(entry, error)
                if outcome is None:
                    # Kept but unverified: never report it as ready or hand out the URL.
                    return {'status': 'pending', 'message': entry['error'], 'misses': entry['misses'], 'frontendPort': entry['frontend']}
                if isinstance(outcome, subprocess.TimeoutExpired):
                    return {'status': 'pending', 'message': entry['error'], 'frontendPort': entry['frontend']}
                raise outcome
        if r['operation'] == 'stop':
            if not entry:
                current = self.runtime.current(r['workspaceId'], r['service'])
                entry = {'workspaceId': r['workspaceId'], 'service': r['service'], 'cwd': current['cwd']}
                # A stop without a reservation still needs a durable replay barrier.
                self.ledger['entries'][key] = entry
            entry.update(desired='stopped', status='stopped', stoppedAt=now, stopReason='stopped')
            for stale in ('url', 'misses', 'error', 'restartedAt', 'daemonWorker'):
                entry.pop(stale, None)
            self.save()
            if entry.get('backend'):
                self.remove(entry)
            current = self.runtime.current(r['workspaceId'], r['service'])
            if current['lifecycle'] == 'running':
                self.runtime.lifecycle('stop', current)
            return {'status': 'stopped'}
        current = self.runtime.current(r['workspaceId'], r['service'])
        if entry and 'frontend' not in entry:
            del self.ledger['entries'][key]
            entry = None
        entry = self.reserve(r, current)
        if r['operation'] == 'start' and current['lifecycle'] == 'running' and entry['fingerprint'] != current['fingerprint']:
            changed = ValueError('Running service configuration changed; use explicit restart')
            if entry.get('backend'):
                self.remove_then_raise(entry, changed)
            raise changed
        if entry.get('backend') and (r['operation'] == 'restart' or entry.get('fingerprint') != current['fingerprint'] or entry.get('terminal') != current.get('terminalId')):
            self.remove(entry)
            entry.pop('terminal', None)
            entry.pop('listener', None)
        if r['operation'] == 'restart' and current['lifecycle'] == 'running':
            self.runtime.lifecycle('stop', current)
            current = self.runtime.current(r['workspaceId'], r['service'])
        entry.update(desired='running', status='pending', fingerprint=current['fingerprint'])
        for stale in ('recovery', 'misses', 'stopReason', 'restartedAt', 'daemonWorker'):
            entry.pop(stale, None)
        self.save()
        # This is startup configuration, not a verified browser link.
        atomic(self.channel / 'origins' / (key + '.json'), {'origin': f'https://{self.address(entry)}', 'workspaceId': r['workspaceId'], 'service': r['service']}, mode=0o644)
        if current['lifecycle'] != 'running':
            self.runtime.lifecycle('start', current)
            entry.pop('terminal', None)
            entry.pop('listener', None)
        try:
            return self.activate(entry)
        except subprocess.SubprocessError:
            if entry.get('mappingIntent'):
                try:
                    self.remove(entry)
                except subprocess.SubprocessError:
                    entry['removalPending'] = True
            entry.update(status='pending')
            self.save()
            return {'status': 'pending', 'message': 'Backend or HTTPS is not ready; inspect status', 'frontendPort': entry['frontend']}

    def observed_daemon_worker(self):
        try:
            return self.runtime.daemon_worker()
        except Exception:
            return None  # Only explains stops; an unanswered check records no cause.

    def record_stop_cause(self, entry, error):
        for stale in ('stopReason', 'restartedAt'):
            entry.pop(stale, None)
        reason = self.service_gone_cause(entry) if isinstance(error, ServiceGone) else getattr(error, 'reason', None)
        if reason:
            entry['stopReason'] = reason

    def service_gone_cause(self, entry):
        """Why a verified service is gone, or None when that cannot be shown.

        'exited' needs the same daemon worker still serving. 'daemon_restart' needs
        a new worker that started after, and within RESTART_ATTRIBUTION_SECONDS of,
        the last verification under the old one. Anything else records no cause."""
        before = entry.get('daemonWorker')
        verified = entry.get('verifiedAt')
        if not before or type(verified) not in (int, float):
            return None
        now = self.observed_daemon_worker()
        if not now:
            return None
        if now['identity'] == before['identity']:
            return 'exited'
        if 0 <= now['startedAt'] - verified <= RESTART_ATTRIBUTION_SECONDS:
            entry['restartedAt'] = now['startedAt']
            return 'daemon_restart'
        return None

    def publish_status(self):
        """Write every reservation's state for the daemon and helper to read.

        Only STATUS_FIELDS leave the ledger: names, ports, states, times and an error
        that is one of this module's fixed messages or an exception type name. No paths,
        terminals, listeners, fingerprints, URLs or command lines."""
        services = []
        # Every reservation, uncapped: the ledger holds at most 32 (reserve() refuses more).
        for entry in self.ledger['entries'].values():
            if 'frontend' not in entry:
                continue
            item = {field: entry[field] for field in STATUS_FIELDS if field in entry}
            if 'error' in item:
                item['error'] = public_error(item['error'])
            services.append(item)
        # publishedAt says the broker is running; each entry's checkedAt says when that
        # entry was last rechecked, which a run that spends its deadline on requests skips.
        atomic(self.channel / STATUS_FILE, {'version': 1, 'publishedAt': time.time(), 'services': services}, mode=0o644)

    def settle_failure(self, entry, error):
        """Apply one rule to a failed check of a route, for reconcile() and status.

        Returns None while a timeout grace keeps the route, otherwise the error
        that withdrew it. A timeout says nothing about who is listening, so a
        verified route may survive a short run of them. Everything else, and any
        change the in-process listener recheck finds, withdraws at once."""
        try:
            if self.hold_for_timeout(entry, error):
                return None
        except (ValueError, ListenerLost) as changed:
            error = changed
        except Exception:
            pass  # A recheck that cannot answer grants no grace.
        # A stopped entry only retries its removal; it has no route to recover.
        timed_out = isinstance(error, subprocess.TimeoutExpired) and entry.get('desired') == 'running'
        # Fail closed on process/config changes. Never revive a stopped service.
        if isinstance(error, ValueError):
            entry.update(desired='stopped', stoppedAt=time.time())
            self.record_stop_cause(entry, error)
        if timed_out:
            message = 'Checks timed out; route withdrawn until a check succeeds'
        elif isinstance(error, (ValueError, RecoveryPending, ListenerLost)) and str(error) in BROKER_MESSAGES:
            message = str(error)
        else:
            # Library errors can echo their input, such as a path or parsed text.
            message = type(error).__name__
        # Keep 'failed' after timeouts: the rebind refuses while any entry is 'pending'.
        entry.update(status='pending' if isinstance(error, RecoveryPending) else 'failed', error=message)
        for stale in ('url', 'misses'):
            entry.pop(stale, None)
        try:
            self.remove(entry)
            entry.pop('removalPending', None)
        except ValueError:
            entry['error'] = 'Mapping removal requires administrator review'
            entry['needsReview'] = True
            error = ValueError(entry['error'])
        except Exception:
            # Usually another timeout. The route may still be published; the
            # next cycle retries the removal, so no administrator is needed.
            entry['removalPending'] = True
        self.save()
        return error

    def remove_then_raise(self, entry, definite):
        """Withdraw after a definite failure without letting the removal mask it.

        If the removal itself times out, the route may still be published: record
        the pending removal for the next cycle and raise the definite error, never
        the timeout, so no timeout grace can start from it."""
        try:
            self.remove(entry)
        except subprocess.SubprocessError:
            entry['removalPending'] = True
            self.save()
        raise definite

    def hold_for_timeout(self, entry, error):
        if not isinstance(error, subprocess.TimeoutExpired):
            return False
        if entry.get('desired') != 'running' or entry.get('status') not in ('ready', 'unverified'):
            return False
        misses = entry.get('misses', 0) + 1
        verified = entry.get('verifiedAt')
        if type(verified) not in (int, float) or not 0 <= time.time() - verified < TIMEOUT_GRACE_SECONDS:
            return False
        if entry.get('inProcessCheckAgreed') is not True:
            return False
        if misses >= TIMEOUT_MISS_LIMIT or not self.runtime.listener_unchanged(entry):
            return False
        entry.update(status='unverified', misses=misses,
                     error=f'Checks timed out ({misses} of {TIMEOUT_MISS_LIMIT}); route kept but unverified')
        self.save()
        return True

    def reconcile(self):
        deadline = time.monotonic() + RECONCILE_SECONDS
        entries = list(self.ledger['entries'].values())[:32]
        if not entries:
            return
        cursor = self.ledger.get('reconcileCursor', 0) % len(entries)
        # One serve status read per cycle covers every stopped entry; remove()
        # reads again before it changes anything.
        published = None
        for index in range(len(entries)):
            if time.monotonic() > deadline:
                break
            entry = entries[(cursor + index) % len(entries)]
            self.ledger['reconcileCursor'] = (cursor + index + 1) % len(entries)
            entry['checkedAt'] = time.time()
            self.save()
            if not entry.get('backend'):
                continue
            try:
                if entry['desired'] == 'stopped':
                    if published is None:
                        published = self.runtime.publication()
                    if self.address(entry) in published.get('Web', {}) or str(entry['frontend']) in published.get('TCP', {}):
                        self.remove(entry)
                    continue
                self.restore_after_restart(entry)
                self.activate(entry)
            except Exception as error:
                self.settle_failure(entry, error)

    def run(self):
        with broker_lock(self.root):
            # A process loaded before a managed migration must not use stale pins.
            if self.reload_config is not None:
                fresh = self.reload_config()
                if fresh['deployment'] != str(self.root) or fresh['channel'] != str(self.channel):
                    raise ValueError('Broker topology changed while acquiring lock')
                self.c = fresh
                self.runtime = runtime_for(fresh)
            verify_fence(self.c)
            verify_channel(self.c)
            self.runtime.preflight()
            # Reload inside the lock to serialize concurrent consumers.
            if self.ledger_path.exists():
                self.ledger = safe_read(self.ledger_path, 2 * 1024 * 1024)
            requests = []
            for path in islice((self.channel / 'inbox').iterdir(), 128):
                if not ID.fullmatch(path.stem) or path.suffix != '.json':
                    continue
                try:
                    r = safe_read(path, MAX_BYTES)
                    validate(r, time.time())
                    if r['id'] != path.stem:
                        raise ValueError('Filename identity mismatch')
                    requests.append((path, r))
                except (ValueError, OSError):
                    atomic(self.channel / 'receipts' / path.name, {'status': 'failed', 'error': 'Invalid, unsafe or expired request'}, mode=0o644)
                    path.unlink(missing_ok=True)
            requests.sort(key=lambda item: (item[1]['operation'] != 'stop', item[1]['createdAt']))
            deadline = time.monotonic() + 40
            for path, r in requests[:16]:
                if time.monotonic() > deadline:
                    break
                old = self.ledger['requests'].get(r['id'])
                if old:
                    result = {'status': 'failed', 'error': 'Request already consumed; submit status with a new ID'}
                else:
                    # Journal before action. Crash leaves an indeterminate request that must
                    # be inspected, never replayed as a fresh start.
                    self.ledger['requests'][r['id']] = time.time()
                    self.save()
                    try:
                        result = self.handle(r)
                    except Exception as error:
                        result = {'status': 'failed', 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}
                atomic(self.channel / 'receipts' / path.name, {'id': r['id'], **result}, mode=0o644)
                path.unlink(missing_ok=True)
            self.ledger['requests'] = {k: v for k, v in self.ledger['requests'].items() if v > time.time() - 600}
            self.save()
            for receipt in islice((self.channel / 'receipts').iterdir(), 128):
                if ID.fullmatch(receipt.stem) and receipt.suffix == '.json' and receipt.lstat().st_mtime < time.time() - 86400:
                    receipt.unlink(missing_ok=True)
            if time.monotonic() < deadline:
                self.reconcile()
            self.publish_status()


if __name__ == '__main__':
    try:
        Broker(load(protected=True), reload_config=lambda: load(protected=True)).run()
    except BlockingIOError:
        pass
    except Exception as error:
        print('HTTPS broker check failed: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
