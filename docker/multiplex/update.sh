#!/usr/bin/env bash
set -euo pipefail
deployment="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$deployment/common.sh"
usage='Usage: update.sh IMAGE [GATE_IMAGE], or update.sh --release COMMIT|none (from an installed deployment). For legacy instances, see docs/docker.md.'
if [[ $# -lt 1 || $# -gt 2 || ! -f "$deployment/.container-installation" ]]; then
  echo "$usage" >&2
  exit 1
fi
releases="$deployment/dev-releases"

# Points dev-releases/current at a release, or removes it for "none" so Dev runs its
# image's own daemon. ln -sfn replaces the link in place on macOS and Linux.
select_release() {
  if [[ "$1" == none ]]; then
    rm -f "$releases/current"
  else
    ln -sfn "$1" "$releases/current"
  fi
}

current_release() {
  if [[ -L "$releases/current" ]]; then readlink "$releases/current"; else echo none; fi
}

# The release each image last ran, so returning to an image, by this script's own
# rollback or a caller's, also returns to its release.
selection_file() {
  echo "$releases/.image-$(printf %s "$1" | cksum | cut -d' ' -f1)"
}

# Swaps Dev's daemon to a Host-built release (scripts/installer/dev-release.mjs builds it)
# and restarts only the paseo service. The image, its mounts and the gate stay as they are.
# Restores the previous selection when Dev does not come back healthy on the new one.
if [[ "$1" == --release ]]; then
  if [[ $# != 2 ]]; then
    echo "$usage" >&2
    exit 1
  fi
  target="$2"
  if [[ "$target" != none ]]; then
    if [[ ! "$target" =~ ^[a-f0-9]{40}$ || ! -f "$releases/$target/.vorteo-dev-release.json" ]]; then
      echo "Dev release $target is not built in $releases." >&2
      exit 1
    fi
  fi
  previous="$(current_release)"
  if [[ "$previous" != "$target" && "$previous" != none ]]; then
    ln -sfn "$previous" "$releases/previous"
  fi
  # The daemon runs from its release folder, so the process list proves the selection took.
  # Health alone is not enough: Docker can report the status from before the restart.
  running() {
    local processes attempt
    for attempt in $(seq 1 60); do
      processes="$(paseo_compose exec -T paseo ps -eo args 2>/dev/null || true)"
      if grep -qF 'supervisor-entrypoint.js' <<<"$processes"; then
        if [[ "$1" == none ]]; then
          ! grep -qF '/opt/vorteo/dev-releases/' <<<"$processes"
          return
        fi
        grep -qF "/opt/vorteo/dev-releases/$1/" <<<"$processes"
        return
      fi
      sleep 2
    done
    return 1
  }
  swap() {
    select_release "$1"
    paseo_compose restart paseo && running "$1" && paseo_wait
  }
  echo "Restarting Dev's daemon on release $target. Active tasks will be interrupted; the image and persistent state are retained."
  if swap "$target"; then
    exit 0
  fi
  echo "Dev did not come back healthy on release $target. Restoring $previous." >&2
  if swap "$previous"; then
    echo "Dev runs $previous again." >&2
    exit 3
  fi
  echo 'The previous release did not come back healthy either. Inspect docker compose logs in this deployment.' >&2
  exit 1
fi

if [[ $# == 2 ]] && ! paseo_gate_mode; then
  echo 'Only a gate-mode deployment takes a gate image.' >&2
  exit 1
fi
image="$(paseo_image "$1")"
settings=("PASEO_IMAGE=$image")
if paseo_gate_mode; then
  paseo_gate_capable "$image"
  if [[ $# == 2 ]]; then settings+=("PASEO_GATE_IMAGE=$(paseo_gate_image "$2")"); fi
fi
# Preserve the previous image and all credentials for rollback.
cp -p "$deployment/.env" "$deployment/.env.previous"
umask 077
paseo_env_set "$deployment/.env" "${settings[@]}"
# A new image bakes in its own daemon, which an older selected release must not shadow.
# An image Dev ran before gets back the release it ran with.
mkdir -p "$releases"
chmod 0755 "$releases"
previous_image="$(sed -n 's/^PASEO_IMAGE=//p' "$deployment/.env.previous" | tail -1)"
previous_release="$(current_release)"
if [[ -n "$previous_image" ]]; then
  echo "$previous_release" > "$(selection_file "$previous_image")"
fi
next_release=none
if [[ -f "$(selection_file "$image")" ]]; then
  next_release="$(cat "$(selection_file "$image")")"
  if [[ "$next_release" != none && ! -f "$releases/$next_release/.vorteo-dev-release.json" ]]; then
    next_release=none
  fi
fi
select_release "$next_release"
echo 'Replacing this instance. Active tasks will be interrupted; persistent state is retained.'
# Dev has no network without the gate, so in gate mode both are recreated together.
services=(paseo)
if paseo_gate_mode; then services+=(gate); fi
up() {
  if paseo_gate_mode; then
    paseo_compose up -d --pull never "${services[@]}"
  else
    paseo_compose up -d --no-deps --pull never paseo
  fi
}
if up && paseo_wait; then
  exit 0
fi
# The new image did not become healthy: recreate Dev on the previous image.
echo 'The new image is not healthy. Restoring the previous image.' >&2
cp -p "$deployment/.env.previous" "$deployment/.env"
select_release "$previous_release"
if up && paseo_wait; then
  echo 'Dev runs the previous image again.' >&2
  exit 3
fi
echo 'The previous image did not come back healthy either. Inspect docker compose logs in this deployment.' >&2
exit 1
