// Shared display names and ordering for real installation and the read-only demo.
export const STEP_TITLES = {
  prepare: "Creating the installation folder",
  identity: "Creating the owner password and installation name",
  tailscale: "Checking Tailscale",
  "dev-images": "Building the Dev and gate images",
  "dev-create": "Creating the Dev container behind the gate",
  "dev-adopt": "Moving the existing Dev container behind the gate",
  "dev-identity": "Reading the Dev identity",
  "projects-access": "Preparing shared project permissions",
  release: "Building the Host release",
  "host-config": "Writing the Host and coordinator configuration",
  "dev-pair": "Pairing Dev with the installation",
  services: "Installing the Host and coordinator services",
  ready: "Waiting for the Host and coordinator",
  remote: "Adding Tailscale HTTPS routes",
  "guest-client": "Giving Dev agents the installation client",
  finish: "Finishing",
};

export function planSteps({ devContainer, adopt, remote }) {
  return [
    "prepare",
    "identity",
    ...(remote === "tailscale" ? ["tailscale"] : []),
    ...(devContainer
      ? ["dev-images", adopt ? "dev-adopt" : "dev-create", "dev-identity", "projects-access"]
      : []),
    "release",
    "host-config",
    ...(devContainer ? ["dev-pair"] : []),
    "services",
    "ready",
    ...(remote === "tailscale" ? ["remote"] : []),
    ...(devContainer ? ["guest-client"] : []),
    "finish",
  ];
}
