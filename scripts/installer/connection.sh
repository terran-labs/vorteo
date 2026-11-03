# shellcheck shell=bash
# shellcheck disable=SC2154 # Caller supplies the documented rendering context.
# Shared connection summary for the standalone installer and installed command.
# Caller supplies node_bin, source_dir, platform, interactive and say().
  # Copies the password without printing it. Returns 1 when no clipboard is available.
  copy_password() {
    [ -r "$1" ] || return 1
    local copier=""
    if [ "$platform" = macos ] && command -v pbcopy >/dev/null 2>&1; then
      copier="pbcopy"
    elif [ -n "${WAYLAND_DISPLAY-}" ] && command -v wl-copy >/dev/null 2>&1; then
      copier="wl-copy"
    elif [ -n "${DISPLAY-}" ] && command -v xclip >/dev/null 2>&1; then
      copier="xclip -selection clipboard"
    else
      return 1
    fi
    tr -d '\r\n' <"$1" | $copier >/dev/null 2>&1 3<&-
  }
  show_qr() {
    local columns="${COLUMNS-}"
    if [ -z "$columns" ]; then columns=$(tput cols 2>/dev/null || printf '80'); fi
    local qr="$source_dir/scripts/installer/qr.mjs" qr_status=0 qr_output=""
    [ -f "$qr" ] || return 0
    say ""
    case "$1" in
      http://localhost:* | http://127.0.0.1:* | http://\[::1\]:*)
        say "  Connection QR code (local address; use it on this computer):" ;;
      *) say "  Scan to open Vorteo on your phone (it must have access to this address):" ;;
    esac
    qr_output=$("$node_bin" "$qr" "$1" --max-width "$((columns - 2))" 3<&-) || qr_status=$?
    if [ "$qr_status" -eq 0 ]; then
      say ""
      printf '%s\n' "$qr_output" | sed 's/^/  /'
    fi
    if [ "$qr_status" -eq 5 ]; then
      say "  Widen the terminal to see a QR code, or open $1 on your phone."
    fi
  }

show_connection() {
  local origin="$1" local_origin="$2" password_file="$3" name="$4"
    printf '\nConnect to %s\n' "${name:-Vorteo}"
    say "  Address:          $origin"
    if [ -n "$local_origin" ] && [ "$local_origin" != "$origin" ]; then
      say "  On this machine:  $local_origin"
    fi
    if copy_password "$password_file"; then
      say "  Owner password:   copied to your clipboard"
    else
      say "  Owner password:   in the file below"
    fi
    say "  Password file:    $password_file"
    if [ -n "$interactive" ]; then
      show_qr "$origin"
    fi
    say ""
    say "  Sign in with the owner password. Everything else, including updates, happens in the interface."
    say "  Commands: vorteo status, vorteo doctor, vorteo open, vorteo update, vorteo repair, vorteo uninstall"
}
