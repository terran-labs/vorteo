#!/usr/bin/env bash
# Refresh the shell libraries embedded in install.sh, which also runs through curl | bash.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
target="$here/../../install.sh"
updated=$(mktemp "${TMPDIR:-/tmp}/install.sh.XXXXXX")
trap 'rm -f "$updated"' EXIT
for name in prerequisites connection; do
  library="$here/$name.sh"
  begin="# BEGIN $name.sh"
  end="# END $name.sh"
  if [ "$(grep -Fc "$begin" "$target")" -ne 1 ] || [ "$(grep -Fxc "$end" "$target")" -ne 1 ]; then
    echo "install.sh must have exactly one BEGIN and END $name.sh marker." >&2
    exit 1
  fi
  awk -v library="$library" -v begin="$begin" -v end="$end" '
    index($0, begin) == 1 {
      print
      while ((getline line < library) > 0) print line
      inside = 1
      next
    }
    $0 == end { inside = 0 }
    !inside { print }
  ' "$target" >"$updated"
  cat "$updated" >"$target"
  echo "Copied $name.sh into install.sh."
done
