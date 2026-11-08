// Loaded with --require during Linux dependency installs. Node's native directory copy in
// fs.cpSync fails with EACCES on the Dev container's virtiofs Projects mount (Node 22 and 24),
// while its JavaScript copy works there. Node takes the native path only without a filter, so
// an accept-all filter keeps every cpSync call, such as @shopify/react-native-skia's
// postinstall, on the working path.
const fs = require("node:fs");
const native = fs.cpSync;
fs.cpSync = function cpSync(src, dest, options) {
  return native(src, dest, { filter: () => true, ...options });
};
