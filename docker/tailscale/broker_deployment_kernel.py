"""Darwin read-only process identity ABI for broker deployment."""
import ctypes, errno, os, struct, sys, uuid
MAX_PIDS=4096
MAX_ARGS=2*1024*1024

class UnsupportedWindow(ValueError):
    pass

class ProcessGone(ProcessLookupError):
    """Only an explicit native ESRCH establishes absence, never EACCES/short reads."""

def arguments(raw):
    """KERN_PROCARGS2 has argc, executable, NUL padding, argv, then environment."""
    if not 5 <= len(raw) <= MAX_ARGS:
        raise ValueError('Invalid native argument buffer size')
    argc = struct.unpack_from('=i', raw)[0]
    if not 1 <= argc <= 4096:
        raise ValueError('Invalid native argument count')
    offset = raw.index(b'\0', 4) + 1
    while offset < len(raw) and raw[offset] == 0:
        offset += 1
    result = []
    for _ in range(argc):
        end = raw.index(b'\0', offset)
        result.append(raw[offset:end].decode('utf-8', errors='strict'))
        offset = end + 1
    return result

class BSDInfo(ctypes.Structure):
    # Same proc_bsdinfo layout used by the maintained NativeRuntime.
    _fields_ = [(name, ctypes.c_uint32) for name in
                ('flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid', 'ruid',
                 'rgid', 'svuid', 'svgid', 'rfu')]
    _fields_ += [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in
                 ('nfiles', 'pgid', 'pjobc', 'tdev', 'tpgid')]
    _fields_ += [('nice', ctypes.c_int32), ('start_sec', ctypes.c_uint64),
                 ('start_usec', ctypes.c_uint64)]

class DarwinKernel:
    """Lazy native ABI port. Tests inject an alternative and never construct this."""
    def __init__(self):
        if sys.platform != 'darwin':
            raise UnsupportedWindow('Darwin process APIs required')
        self.proc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        self.libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        self.proc.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32,
                                           ctypes.c_void_p, ctypes.c_int]
        self.proc.proc_listpids.restype = ctypes.c_int
        self.proc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                          ctypes.c_void_p, ctypes.c_int]
        self.proc.proc_pidinfo.restype = ctypes.c_int
        self.libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                                    ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                                    ctypes.c_void_p, ctypes.c_size_t]
        self.libc.sysctl.restype = ctypes.c_int
        self.libc.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p,
                                         ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p,
                                         ctypes.c_size_t]
        self.libc.sysctlbyname.restype = ctypes.c_int

    def boot(self):
        value = ctypes.create_string_buffer(64)
        size = ctypes.c_size_t(len(value))
        if self.libc.sysctlbyname(b'kern.bootsessionuuid', value, ctypes.byref(size), None, 0):
            raise OSError(ctypes.get_errno(), 'Boot identity unavailable')
        if not 1 <= size.value <= len(value):
            raise ValueError('Invalid boot UUID size')
        return str(uuid.UUID(value.raw[:size.value].rstrip(b'\0').decode('ascii')))

    def pids(self, uid):
        buffer = (ctypes.c_int * (MAX_PIDS + 1))()
        size = self.proc.proc_listpids(4, uid, buffer, ctypes.sizeof(buffer))
        if size <= 0 or size % ctypes.sizeof(ctypes.c_int) or size >= ctypes.sizeof(buffer):
            raise ValueError('Owner process inventory unavailable or exceeds bound')
        result = [pid for pid in buffer[:size // ctypes.sizeof(ctypes.c_int)] if pid > 0]
        if len(result) > MAX_PIDS or len(result) != len(set(result)):
            raise ValueError('Ambiguous owner process inventory')
        return sorted(result)

    def info(self, pid):
        info = BSDInfo()
        ctypes.set_errno(0)
        size = self.proc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size != ctypes.sizeof(info):
            error = ctypes.get_errno()
            if error == errno.ESRCH:
                raise ProcessGone(pid)
            raise OSError(error, 'Native process identity unavailable')
        return {'pid': info.pid, 'parent': info.ppid, 'uids': [info.uid, info.ruid, info.svuid],
                'birth': [info.start_sec, info.start_usec]}

    def argv(self, pid):
        limit = os.sysconf('SC_ARG_MAX')
        if not 0 < limit <= MAX_ARGS:
            raise ValueError('Unsupported native argument limit')
        buffer = ctypes.create_string_buffer(limit)
        size = ctypes.c_size_t(limit)
        mib = (ctypes.c_int * 3)(1, 49, pid)
        ctypes.set_errno(0)
        if self.libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0):
            error = ctypes.get_errno()
            if error == errno.ESRCH:
                raise ProcessGone(pid)
            raise OSError(error, 'Native arguments unavailable')
        if not 0 < size.value <= limit:
            raise ValueError('Native argument bound changed')
        return arguments(buffer.raw[:size.value])

