import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

import type { SnapshotMetadata } from "./snapshot.js";

export type SnapshotUploader = {
  readonly name: string;
  upload(snapshot: SnapshotMetadata): Promise<void>;
};

export type GitHubBranchUploaderOptions = {
  remote: string;
  branch: string;
  workdir: string;
};

export function createGitHubBranchUploader(options: GitHubBranchUploaderOptions): SnapshotUploader {
  const { remote, branch, workdir } = options;
  return {
    name: `github-branch:${remote}/${branch}`,
    async upload(snapshot: SnapshotMetadata): Promise<void> {
      if (!existsSync(snapshot.path)) {
        throw new Error(`Snapshot file no longer exists on disk: ${snapshot.path}`);
      }
      const fileName = basename(snapshot.path);
      // Stage the snapshot file at the repo root so the GitHub Actions
      // workflow can pick it up via `actions/upload-artifact` with a
      // predictable path regardless of where the bot stores it.
      runGit(workdir, ["checkout", "-B", branch, "--"]);
      runGit(workdir, ["add", "--", fileName]);
      // `--allow-empty` keeps the branch healthy even if the same snapshot
      // file name (unlikely, but possible across months) is staged twice.
      runGit(workdir, [
        "commit",
        "--allow-empty",
        "-m",
        `snapshot: ${fileName} (${snapshot.createdAt})`,
      ]);
      runGit(workdir, ["push", "--force-with-lease", remote, branch]);
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
    async upload(snapshot: SnapshotMetadata): Promise<void> {
      const errors: unknown[] = [];
      for (const uploader of uploaders) {
        try {
          await uploader.upload(snapshot);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === uploaders.length && uploaders.length > 0) {
        throw new Error(
          `All snapshot uploaders failed for ${snapshot.path}: ${errors
            .map((error) => (error instanceof Error ? error.message : String(error)))
            .join("; ")}`,
        );
      }
    },
  };
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited with status ${result.status}: ${(
        result.stderr || result.stdout || ""
      ).trim()}`,
    );
  }
}
