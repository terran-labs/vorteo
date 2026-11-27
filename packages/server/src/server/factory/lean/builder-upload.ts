import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { BuilderGitRefusal, builderPublishInput, isBuilderPath } from "./builder-git.js";

export const builderUploadRequest = builderPublishInput.omit({ changes: true }).extend({
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(512).refine(isBuilderPath),
        kind: z.enum(["write", "delete"]),
      }),
    )
    .min(1)
    .max(128),
});

export type BuilderUploadRequest = z.infer<typeof builderUploadRequest>;

export interface BuilderUploadSession {
  workspace: string;
  socketDirectory: string;
  socketPath: string;
  token: string;
  input: BuilderUploadRequest;
  signal: AbortSignal;
}

/** The caller supplies a trusted local Codex CLI. The model only controls the bounded request. */
export function createMacBuilderUploader(codexPath: string) {
  if (process.platform !== "darwin" || !isAbsolute(codexPath)) {
    throw new BuilderGitRefusal("Builder uploads require a verified Codex sandbox on this host.");
  }
  return async function upload(session: BuilderUploadSession): Promise<void> {
    const filesystem = `{":root"="deny",":tmpdir"="deny",":slash_tmp"="deny",":minimal"="read","/System/Library/Perl"="read",${JSON.stringify(session.workspace)}="read"}`;
    const policy = `permissions.lean-builder-upload={filesystem=${filesystem},network={enabled=false}}`;
    const args = [
      "sandbox",
      "-C",
      session.socketDirectory,
      "-P",
      "lean-builder-upload",
      "-c",
      policy,
      "--allow-unix-socket",
      session.socketDirectory,
      "--",
      "/usr/bin/perl",
      "-e",
      collector,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(codexPath, args, {
        cwd: session.socketDirectory,
        env: { PATH: "/usr/bin:/bin" },
        signal: session.signal,
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.stdin.on("error", () => {});
      child.once("error", () =>
        reject(new BuilderGitRefusal("The confined Builder uploader could not start.")),
      );
      child.once("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new BuilderGitRefusal(
              "The confined Builder helper could not upload the approved files. Verify the workspace and exact local socket permission.",
            ),
          );
      });
      child.stdin.end(
        JSON.stringify({
          workspace: session.workspace,
          socket: session.socketPath,
          token: session.token,
          input: session.input,
        }),
      );
    });
  };
}

// Fixed code and stdin JSON only. No subprocess, file writes, TCP, env secrets or repository config.
const collector = String.raw`
use strict;
use warnings;
use Encode qw(encode_utf8);
use Fcntl qw(O_RDONLY O_NOFOLLOW O_NONBLOCK S_ISREG);
use IO::Socket::UNIX;
use JSON::PP qw(decode_json encode_json);
use MIME::Base64 qw(encode_base64);
use Socket qw(SOCK_STREAM);
local $/;
my $data = decode_json(<STDIN>);
my $input = $data->{input};
my $remaining = 4 * 1024 * 1024;
my @changes;
for my $file (@{delete $input->{files}}) {
    my $path = $file->{path};
    my @parts = split m{/}, $path, -1;
    die "invalid path" if $path =~ /[\\\x00-\x1f\x7f]/ || grep { $_ eq "" || $_ eq "." || $_ eq ".." || lc($_) eq ".git" } @parts;
    if ($file->{kind} eq "delete") {
        push @changes, { kind => "delete", path => $path };
        next;
    }
    my $target = $data->{workspace};
    for my $part (@parts) {
        $target .= "/" . $part;
        die "symbolic link" if -l encode_utf8($target);
    }
    sysopen(my $handle, encode_utf8($target), O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or die "open";
    my @before = stat($handle);
    die "not a regular file" unless @before && S_ISREG($before[2]) && $before[3] == 1;
    die "upload size" if $before[7] > $remaining;
    my $bytes = "";
    while (length($bytes) <= $before[7]) {
        my $count = sysread($handle, my $chunk, $before[7] + 1 - length($bytes));
        die "file read" unless defined $count;
        last unless $count;
        $bytes .= $chunk;
    }
    my @after = stat($handle);
    close $handle;
    die "file changed" unless length($bytes) == $before[7] && $after[7] == $before[7] && $after[9] == $before[9];
    $remaining -= length($bytes);
    push @changes, {kind => "write", path => $path, base64 => encode_base64($bytes, ""), executable => ($before[2] & 0111) ? JSON::PP::true : JSON::PP::false};
}
$input->{changes} = \@changes;
my $body = encode_json($input);
my $socket = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $data->{socket}) or die "private socket";
binmode($socket, ":raw");
$socket->autoflush(1);
my $request = "POST /upload HTTP/1.1\r\nHost: factory-builder\r\nConnection: close\r\nAuthorization: Bearer " . $data->{token} . "\r\nContent-Type: application/json\r\nContent-Length: " . length($body) . "\r\n\r\n" . $body;
print {$socket} $request or die "upload";
$/ = "\r\n";
my $response = <$socket>;
die "refused" unless defined $response && $response =~ m{^HTTP/1\.[01] 204 };
close $socket;
`;
