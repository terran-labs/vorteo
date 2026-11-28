import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { constants } from "node:os";
import path from "node:path";

const fullId = /^[a-f0-9]{64}$/;

function requireField(condition) {
  if (!condition) throw new Error("Incomplete Docker container inventory");
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.length > 0;
}

function absolute(value) {
  requireField(text(value) && path.isAbsolute(value));
  return value;
}

// Docker maps are unordered. Encode them consistently for comparison across reads.
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function mountRequests(hostConfig, canonicalize) {
  const entries = hostConfig.Mounts ?? [];
  requireField(Array.isArray(entries));
  return sorted(
    entries.map((entry) => {
      requireField(record(entry) && text(entry.Type));
      return {
        Type: entry.Type,
        Target: absolute(entry.Target),
        Source:
          entry.Type === "bind" ? canonicalize(absolute(entry.Source)) : (entry.Source ?? null),
        ReadOnly: entry.ReadOnly === true,
        BindOptions: entry.Type === "bind" ? stableValue(entry.BindOptions ?? null) : null,
        VolumeSubpath: entry.VolumeOptions?.Subpath ?? null,
        TmpfsOptions: entry.Type === "tmpfs" ? stableValue(entry.TmpfsOptions ?? null) : null,
      };
    }),
  );
}

function sorted(values) {
  return values.sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

function mountRecord(mount, canonicalize, overlapsSocket) {
  requireField(record(mount) && text(mount.Type) && typeof mount.RW === "boolean");
  const destination = absolute(mount.Destination);
  if (mount.Type === "bind" || mount.Type === "volume") absolute(mount.Source);
  if (mount.Type === "volume") requireField(text(mount.Name));
  const source = mount.Source ? canonicalize(absolute(mount.Source)) : null;
  return {
    type: mount.Type,
    name: mount.Name ?? null,
    source,
    destination,
    readWrite: mount.RW,
    propagation: mount.Propagation ?? null,
    mode: mount.Mode ?? null,
    engineSocket: source !== null && overlapsSocket(source),
  };
}

function tmpfsEntries(hostConfig, mounts, requests) {
  const entries = new Map(
    mounts.filter((mount) => mount.type === "tmpfs").map(({ destination }) => [destination, null]),
  );
  for (const request of requests) {
    if (request.Type === "tmpfs") entries.set(request.Target, request.TmpfsOptions ?? null);
  }
  if (hostConfig.Tmpfs != null) {
    requireField(record(hostConfig.Tmpfs));
    for (const [destination, options] of Object.entries(hostConfig.Tmpfs)) {
      requireField(typeof options === "string");
      entries.set(absolute(destination), options);
    }
  }
  return sorted(Array.from(entries, ([destination, options]) => ({ destination, options })));
}

function isLoopback(ip) {
  if (isIP(ip) === 4) return ip.startsWith("127.");
  if (isIP(ip) === 6) return new URL(`http://[${ip}]/`).hostname === "[::1]";
  return false;
}

function portBindings(table) {
  if (table === null) return [];
  requireField(record(table));
  const ports = [];
  for (const [containerPort, endpoints] of Object.entries(table)) {
    requireField(/^\d+\/(tcp|udp|sctp)$/.test(containerPort));
    if (endpoints === null) continue; // Exposed without a host publication.
    requireField(Array.isArray(endpoints));
    for (const endpoint of endpoints) {
      requireField(
        record(endpoint) &&
          typeof endpoint.HostIp === "string" &&
          typeof endpoint.HostPort === "string",
      );
      const { HostIp: hostIp, HostPort: hostPort } = endpoint;
      ports.push({ containerPort, hostIp, hostPort, nonLoopback: !isLoopback(hostIp) });
    }
  }
  return sorted(ports);
}

function containerRecord(raw, canonicalize, overlapsSocket) {
  requireField(record(raw) && fullId.test(raw.Id) && text(raw.Name) && text(raw.State?.Status));
  requireField(
    Array.isArray(raw.Mounts) && text(raw.HostConfig?.NetworkMode) && record(raw.NetworkSettings),
  );
  const mounts = sorted(raw.Mounts.map((m) => mountRecord(m, canonicalize, overlapsSocket)));
  const declaredMounts = mountRequests(raw.HostConfig, canonicalize);
  const networks = raw.NetworkSettings.Networks;
  requireField(networks === null || record(networks));
  const configuredPorts = portBindings(raw.HostConfig.PortBindings);
  const activePorts = portBindings(raw.NetworkSettings.Ports);
  const combined = new Map(
    [...configuredPorts, ...activePorts].map((port) => [JSON.stringify(port), port]),
  );
  const publishedPorts = sorted([...combined.values()]);
  return {
    id: raw.Id,
    name: raw.Name,
    state: raw.State.Status,
    imageId: raw.Image ?? null,
    imageDigest: raw.ImageManifestDescriptor?.digest ?? null,
    mounts,
    declaredMounts,
    tmpfs: tmpfsEntries(raw.HostConfig, mounts, declaredMounts),
    networkMode: raw.HostConfig.NetworkMode,
    networks: sorted(
      Object.entries(networks ?? {}).map(([name, endpoint]) => {
        requireField(record(endpoint));
        return {
          name,
          id: endpoint.NetworkID ?? null,
          endpoint: endpoint.EndpointID ?? null,
          address: endpoint.IPAddress ?? null,
          ipv6: endpoint.GlobalIPv6Address ?? null,
          ipam: stableValue(endpoint.IPAMConfig ?? null),
          aliases: sorted([...(endpoint.Aliases ?? [])]),
        };
      }),
    ),
    hostNetwork: raw.HostConfig.NetworkMode === "host",
    configuredPorts,
    publishAllPorts: raw.HostConfig.PublishAllPorts === true,
    activePorts,
    publishedPorts,
    nonLoopbackPorts: publishedPorts.some((port) => port.nonLoopback),
    engineSocket:
      mounts.some((mount) => mount.engineSocket) ||
      declaredMounts.some((mount) => mount.Type === "bind" && overlapsSocket(mount.Source)),
  };
}

function resolveNetworkOwners(containers) {
  const owners = new Map();
  for (const row of containers) {
    const visited = new Set();
    let peer = row;
    while (peer.networkMode.startsWith("container:")) {
      requireField(!visited.has(peer.id));
      visited.add(peer.id);
      const ref = peer.networkMode.slice("container:".length);
      const matches = containers.filter(
        (other) =>
          other.name.replace(/^\//, "") === ref || (ref.length >= 12 && other.id.startsWith(ref)),
      );
      requireField(matches.length === 1);
      [peer] = matches;
    }
    owners.set(row.id, peer);
  }
  return owners;
}

async function inspectRows(docker, ids, run) {
  if (!ids.length) return [];
  let status = "";
  try {
    return JSON.parse(await run(docker, ["inspect", ...ids], { timeout: 15000 }));
  } catch (error) {
    // Inspect output may include unrelated private configuration.
    if (Number.isInteger(error?.code)) status = ` (exit ${error.code})`;
    else if (error?.code === "ETIMEDOUT") status = " (ETIMEDOUT)";
    else if (Object.hasOwn(constants.signals, error?.signal)) status = ` (${error.signal})`;
  }
  throw new Error(`Incomplete Docker container inventory: inspect failed${status}`);
}

async function readRows(docker, run) {
  // Injected command runners must forward the timeout to the child process.
  const listed = await run(docker, ["ps", "-aq"], { timeout: 15000 });
  requireField(typeof listed === "string");
  const ids = listed.trim() ? listed.trim().split(/\s+/) : [];
  requireField(
    ids.every((id) => /^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(id)) &&
      new Set(ids).size === ids.length,
  );
  const raw = await inspectRows(docker, ids, run);
  requireField(Array.isArray(raw) && raw.length === ids.length);
  for (const [index, row] of raw.entries()) {
    requireField(
      record(row) &&
        fullId.test(row.Id) &&
        row.Id.startsWith(ids[index]) &&
        Array.isArray(row.Mounts),
    );
    for (const mount of row.Mounts) {
      requireField(record(mount) && text(mount.Type) && typeof mount.RW === "boolean");
      if (mount.Type === "bind") absolute(mount.Source);
    }
  }
  requireField(new Set(raw.map((row) => row.Id)).size === ids.length);
  return raw;
}

// Path checks use the mount projection even if a stopped container's network peer has gone.
export async function collectWritableBindRoots(docker, run) {
  const rows = await readRows(docker, run);
  return rows.flatMap(({ Mounts }) =>
    Mounts.filter((mount) => mount.Type === "bind" && mount.RW).map((mount) => mount.Source),
  );
}

/** Read one point-in-time inventory. Consumers compare a new digest before reusing a binding. */
export async function collectContainerInventory(docker, options, run, canonicalize, within) {
  const {
    installationId,
    boundContainerId,
    engineSocketPaths = ["/var/run/docker.sock"],
  } = options;
  if (boundContainerId !== undefined && !(text(installationId) && fullId.test(boundContainerId)))
    throw new Error("A bound inventory requires the installation and full container identity");
  if (boundContainerId !== undefined && !options.engineSocketPaths?.length)
    throw new Error("A bound inventory requires the engine socket paths");
  const sockets = engineSocketPaths.map((socket) => canonicalize(absolute(socket)));
  const overlapsSocket = (source) =>
    sockets.some((socket) => within(socket, source) || within(source, socket));
  const rows = await readRows(docker, run);
  const containers = rows.map((row) => containerRecord(row, canonicalize, overlapsSocket));
  const owners = resolveNetworkOwners(containers);
  for (const row of containers) {
    const peer = owners.get(row.id);
    row.networkOwnerId = peer.id;
    row.hostNetwork = peer.networkMode === "host";
    row.effectivePublishedPorts = peer.publishedPorts;
    row.nonLoopbackPorts = peer.publishedPorts.some((port) => port.nonLoopback);
  }
  let boundDigest = null;
  if (boundContainerId !== undefined) {
    const bound = containers.find(({ id }) => id === boundContainerId);
    if (!bound) throw new Error("Bound container is absent from the Docker inventory");
    const {
      id,
      imageDigest,
      mounts,
      declaredMounts,
      tmpfs,
      networkMode,
      networks,
      configuredPorts,
      activePorts,
    } = bound;
    boundDigest = createHash("sha256")
      .update(
        JSON.stringify([
          "container-inventory-v1",
          installationId,
          [...new Set(sockets)].sort(),
          id,
          bound.imageId,
          imageDigest,
          mounts,
          declaredMounts,
          tmpfs,
          networkMode,
          networks,
          configuredPorts,
          activePorts,
          bound.publishAllPorts,
          bound.networkOwnerId,
          owners.get(bound.id).networkMode,
          owners.get(bound.id).networks,
          owners.get(bound.id).publishAllPorts,
          owners.get(bound.id).publishedPorts,
        ]),
      )
      .digest("hex");
  }
  return {
    installationId: installationId ?? null,
    boundContainerId: boundContainerId ?? null,
    containers,
    boundDigest,
  };
}
