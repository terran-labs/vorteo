"""Bounded native broker observations. Importing this module has no effects."""
import json
import os
from pathlib import Path
import plistlib
import re
import selectors
import stat
import subprocess
import time
from broker_deployment_kernel import DarwinKernel, ProcessGone
from broker_deployment import sha, encode
from channel_identity import read_file, file_identity, physical_directory, verify_channel

def run(argv):
    process=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                             env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
    selector=selectors.DefaultSelector();output={'out':bytearray(),'err':bytearray()}
    for stream,name in [(process.stdout,'out'),(process.stderr,'err')]:
        os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ,name)
    deadline=time.monotonic()+15
    try:
        while selector.get_map():
            if time.monotonic()>=deadline:raise TimeoutError('Native observation deadline exceeded')
            for key,_ in selector.select(min(0.2,max(0,deadline-time.monotonic()))):
                raw=os.read(key.fileobj.fileno(),65536)
                if not raw:selector.unregister(key.fileobj);continue
                output[key.data].extend(raw)
                if sum(map(len,output.values()))>1024*1024:raise ValueError('Native diagnostic exceeds bound')
        code=process.wait(timeout=max(0.01,deadline-time.monotonic()))
        return subprocess.CompletedProcess(argv,code,output['out'].decode(),output['err'].decode())
    except BaseException:
        process.kill();process.wait();raise
    finally:
        selector.close();process.stdout.close();process.stderr.close()

def diagnostic(raw,header,service=False):
    if not isinstance(raw,str) or len(raw.encode())>1024*1024:raise ValueError('Diagnostic exceeds bound')
    lines=raw.splitlines()
    if not lines or lines[0]!=header+' = {' or lines[-1]!='}':raise ValueError('Incomplete native diagnostic')
    depth=1;pids=[]
    for index,line in enumerate(lines[1:],1):
        stripped=line.strip()
        if stripped=='}':
            depth-=1
            if depth<0 or (depth==0 and index!=len(lines)-1):raise ValueError('Trailing native diagnostic')
            continue
        if depth<=0:raise ValueError('Trailing native content')
        match=re.fullmatch(r'pid = ([1-9][0-9]*)',stripped)
        if match and service:
            if depth!=1 or line!='\t'+stripped:raise ValueError('Nested or malformed process field')
            pids.append(int(match[1]))
        if stripped.endswith('{'):depth+=1
    if depth!=0 or len(pids)>1:raise ValueError('Unbalanced or ambiguous native diagnostic')
    return pids[0] if pids else None


def registration(label, uid, invoke=run):
    """Recognize only a narrow native diagnostic grammar, never any nonzero as absent."""
    if not re.fullmatch(r'[A-Za-z0-9.-]+',label):raise ValueError('Invalid label')
    domain=f'gui/{uid}'
    result=invoke(['/bin/launchctl','print',domain+'/'+label])
    if result.returncode==0:
        if result.stderr.strip():raise ValueError('Unexpected native diagnostic error')
        pid=diagnostic(result.stdout,domain+'/'+label,True)
        return {'state':'loaded','pid':pid,'diagnosticSha256':sha(result.stdout.encode())}
    proof=invoke(['/bin/launchctl','print',domain])
    expected=f'Could not find service "{label}" in domain for user gui: {uid}'
    lines=result.stderr.splitlines()
    if (result.returncode==113 and not result.stdout and lines in ([expected],['Bad request.',expected])
            and proof.returncode==0 and not proof.stderr.strip()):
        diagnostic(proof.stdout,domain)
        return {'state':'absent','pid':None,'diagnosticSha256':sha(result.stderr.encode())}
    raise ValueError('Native registration state unresolved')



def disabled_overrides(raw, domain):
    """Parse the complete print-disabled map; unknown diagnostics never mean enabled."""
    if not isinstance(raw, str) or len(raw.encode()) > 1024 * 1024:
        raise ValueError('Disabled diagnostic exceeds bound')
    lines = raw.strip().splitlines()
    if not lines or lines[0].strip() != 'disabled services = {' or lines[-1].strip() != '}':
        raise ValueError('Incomplete disabled service diagnostic')
    result = {}
    for line in lines[1:-1]:
        match = re.fullmatch(r'\s*"([A-Za-z0-9._-]+)" => (true|false|enabled|disabled)\s*', line)
        if not match or match[1] in result:
            raise ValueError('Ambiguous disabled service diagnostic')
        result[match[1]] = match[2] in ('true', 'disabled')
    return result


class NativeObservation:
    def __init__(self, plan, bindings, guard, kernel=None, invoke=run):
        self.plan = plan
        self.bindings = bindings
        self.guard = guard
        self.kernel = kernel or DarwinKernel()
        self.invoke = invoke

    def process(self, pid):
        try:
            before = self.kernel.info(pid)
            argv = self.kernel.argv(pid)
            after = self.kernel.info(pid)
        except ProcessGone:
            return None
        if before != after or before['pid'] != pid or before['uids'] != [os.getuid()] * 3:
            raise ValueError('Native process custody changed')
        return {'pid': pid, 'birth': before['birth'], 'uid': os.getuid(), 'argv': argv}

    def old_process_exited(self, expected):
        if expected is None:
            return True
        observed = self.process(expected['pid'])
        return observed is None or observed['birth'] != expected['birth']

    def state(self, binding):
        self.guard()
        if self.kernel.boot() != self.plan['bootUUID']:
            raise ValueError('Deployment boot changed')
        domain = f'gui/{os.getuid()}'
        if binding['domain'] != domain:
            raise ValueError('Foreign broker domain')
        raw, _ = read_file(binding['plist']['path'], protected=True)
        if sha(raw) != binding['plist']['sha256']:
            raise ValueError('Broker plist changed')
        record = plistlib.loads(raw)
        if (record.get('Label') != binding['label'] or
                record.get('ProgramArguments') != binding['argv'] or
                binding['argv'] != [binding['interpreter'], '-I', str(Path(binding['root']) / 'https_broker.py')] or
                type(record.get('Disabled', False)) is not bool):
            raise ValueError('Plist does not match the protected broker route')
        config_raw, _ = read_file(Path(binding['root']) / 'host-config.json', protected=True)
        config = json.loads(config_raw)
        if config.get('deployment') != binding['root'] or config.get('brokerLabel') != binding['label']:
            raise ValueError('Broker configuration route changed')
        disabled = self.invoke(['/bin/launchctl', 'print-disabled', domain])
        if disabled.returncode or disabled.stderr.strip():
            raise ValueError('Disabled service state unavailable')
        overrides = disabled_overrides(disabled.stdout, domain)
        override = overrides.get(binding['label'])
        enabled = not (record.get('Disabled', False) if override is None else override)
        reg = registration(binding['label'], os.getuid(), self.invoke)
        process = self.process(reg['pid']) if reg['pid'] else None
        if process is not None and process['argv'] != binding['argv']:
            raise ValueError('Registered broker process differs from protected route')
        self.guard()
        return {'disposition': reg['state'], 'enabled': enabled,
                'override': 'absent' if override is None else ('disabled' if override else 'enabled'),
                'process': process, 'registration': reg,
                'overrideSha256': sha(disabled.stdout.encode()), 'overrideDiagnostic': disabled.stdout,
                'plistSha256': sha(raw)}

    def validate(self):
        if len(self.bindings) != 2 or len(self.plan['registrations']) != 2:
            raise ValueError('Exact broker pair required')
        if {item['root'] for item in self.bindings} != {item['root'] for item in self.plan['targets']}:
            raise ValueError('Protected broker roots differ')
        result = []
        for expected, binding in zip(self.plan['registrations'], self.bindings):
            for key in ('root', 'domain', 'label', 'plist'):
                if expected[key] != binding[key]:
                    raise ValueError('Approved registration differs from protected binding')
            state = self.state(binding)
            for key in ('disposition', 'enabled', 'override', 'process'):
                if state[key] != expected[key]:
                    raise ValueError('Prepared broker state changed')
            if state['disposition'] == 'loaded' and not state['enabled']:
                raise ValueError('Loaded disabled broker restoration is unsupported')
            self.assert_refusing_channel(binding)
            result.append(state)
        self.assert_manual_exited()
        self.assert_no_unlisted([state["process"] for state in result])
        return result

    def assert_no_unlisted(self, allowed):
        admitted = {item['pid']: item for item in allowed if item is not None}
        routes = {str(Path(binding['root']) / name) for binding in self.bindings
                  for name in ('https_broker.py', 'https-preview.py')}
        for pid in self.kernel.pids(os.getuid()):
            process = self.process(pid)
            if process is not None and any(arg in routes for arg in process['argv']):
                if admitted.get(pid) != process:
                    raise ValueError('Unlisted broker caller or waiting generation remains')

    def assert_manual_exited(self):
        for participant in self.plan['manualParticipants']:
            if not self.old_process_exited(participant):
                raise ValueError('Declared manual or waiting consumer is still active')

    def assert_refusing_channel(self, binding):
        # This first deployment restores only consumers whose unchanged legacy
        # channel pins still refuse before inbox consumption. Trust is separate.
        raw, _ = read_file(Path(binding['root']) / 'host-config.json', protected=True)
        config = json.loads(raw)
        if config.get('channelFilesystemIdentity') is not None:
            raise ValueError('Restoration requires a separately reviewed trusted-channel policy')
        try:
            verify_channel(config)
        except ValueError as error:
            if str(error) == 'Request channel replaced; administrator review required':
                return
            raise
        raise ValueError('Consumer could process requests on resume; separate release admission required')

    def assert_suppressed(self):
        self.assert_manual_exited()
        self.assert_no_unlisted([])
        for expected, binding in zip(self.plan['registrations'], self.bindings):
            state = self.state(binding)
            if state['disposition'] != 'absent' or state['enabled']:
                raise ValueError('Broker scheduler suppression is unverified')
            if not self.old_process_exited(expected['process']):
                raise ValueError('Old registered consumer remains active')
            self.assert_refusing_channel(binding)
        return {'bootUUID': self.plan['bootUUID'], 'request': self.plan['id'],
                'bindingsSha256': sha(encode(self.bindings))}
