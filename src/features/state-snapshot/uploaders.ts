import type { EncryptedSnapshot } from "./snapshot.js";

export type SnapshotUploader = {
  readonly name: string;
  /**
   * Upload a snapshot's encrypted bytes. The boundary accepts only
   * `EncryptedSnapshot` so the caller is forced to validate the bytes
   * via `loadEncryptedSnapshot` first. This eliminates the
   * "path-to-bytes" data flow that would otherwise let a CodeQL-style
   * taint analysis warn about file data leaking into an outbound
   * network request.
   */
  upload(encrypted: EncryptedSnapshot): Promise<void>;
};

export type GitHubApiUploaderOptions = {
  repo: string;
  branch: string;
  token: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
};

// Uploads an encrypted snapshot to a GitHub branch via the Git Data REST API.
//
// We use the REST API (not a local `git checkout`) because:
//   - The container runtime does not ship a `git` binary or `.git` directory.
//   - Mutating `process.cwd()` (the live worktree) would collide with the
//     running bot's repository state on a dev host.
//   - The GitHub Actions workflow picks up the snapshot from the same branch,
//     so the upload only needs to commit a single file to the branch root.
//
// `encrypted.bytes` is already validated by `loadEncryptedSnapshot`. The
// uploader does not read from disk — it only base64-encodes the
// pre-validated bytes into the Git Data blob API.
export function createGitHubApiUploader(options: GitHubApiUploaderOptions): SnapshotUploader {
  const { repo, branch, token } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "ido-bata-state-snapshot-uploader",
    "X-GitHub-Api-Version": "2022-11-28",
  } as const;

  const request = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `GitHub API ${method} ${path} failed with ${response.status}: ${detail.slice(0, 500)}`,
      );
    }
    return response;
  };

  return {
    name: `github-api:${repo}:${branch}`,
    async upload(encrypted: EncryptedSnapshot): Promise<void> {
      const fileName = basename(encrypted.meta.path);
      const fileBytes = encrypted.bytes;
      const fileBase64 = fileBytes.toString("base64");

      // 1. Resolve the branch's current head commit.
      const refResponse = await request("GET", `/repos/${repo}/git/ref/heads/${branch}`);
      const refData = (await refResponse.json()) as { object: { sha: string } };
      const headCommitSha = refData.object.sha;

      // 2. Fetch the head commit so we can build a new tree on top of it.
      const commitResponse = await request("GET", `/repos/${repo}/git/commits/${headCommitSha}`);
      const commitData = (await commitResponse.json()) as { tree: { sha: string } };
      const baseTreeSha = commitData.tree.sha;

      // 3. Upload the encrypted bytes as a blob (no working tree required).
      const blobResponse = await request("POST", `/repos/${repo}/git/blobs`, {
        content: fileBase64,
        encoding: "base64",
      });
      const blobData = (await blobResponse.json()) as { sha: string };

      // 4. Build a new tree that reuses the previous tree and adds this snapshot.
      const treeResponse = await request("POST", `/repos/${repo}/git/trees`, {
        base_tree: baseTreeSha,
        tree: [
          {
            mode: "100644",
            path: fileName,
            sha: blobData.sha,
            type: "blob",
          },
        ],
      });
      const treeData = (await treeResponse.json()) as { sha: string };

      // 5. Commit the new tree onto the branch's head.
      const newCommitResponse = await request("POST", `/repos/${repo}/git/commits`, {
        message: `snapshot: ${fileName} (${encrypted.meta.id})`,
        parents: [headCommitSha],
        tree: treeData.sha,
      });
      const newCommitData = (await newCommitResponse.json()) as { sha: string };

      // 6. Fast-forward the branch ref to the new commit. This is the
      //    equivalent of a `--ff-only` push; it never rewrites published
      //    history and never touches the local working tree.
      await request("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, {
        force: false,
        sha: newCommitData.sha,
      });
    },
  };
}

export function createNoopUploader(): SnapshotUploader {
  return {
    name: "noop",
    async upload(): Promise<void> {
      // Intentionally empty: a no-op uploader is the safe default when no
      // remote destination has been configured (e.g. local dev runs).
    },
  };
}

export function createCompositeUploader(uploaders: SnapshotUploader[]): SnapshotUploader {
  return {
    name: uploaders.map((uploader) => uploader.name).join("+") || "noop",
    async upload(encrypted: EncryptedSnapshot): Promise<void> {
      const errors: unknown[] = [];
      for (const uploader of uploaders) {
        try {
          await uploader.upload(encrypted);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === uploaders.length && uploaders.length > 0) {
        throw new Error(
          `All snapshot uploaders failed for ${encrypted.meta.path}: ${errors
            .map((error) => (error instanceof Error ? error.message : String(error)))
            .join("; ")}`,
        );
      }
    },
  };
}

function basename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] ?? path;
}
