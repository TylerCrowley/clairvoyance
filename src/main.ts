// Clairvoyance: Git Demystified
// Copyright (C) 2026 Tyler Crowley
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3
// of the License, or (at your option) any later version.
//
// This program is distributed WITHOUT ANY WARRANTY.
// See the LICENSE file for details.

// -- Imports & Types

import { invoke } from "@tauri-apps/api/core";

import "./styles.css";

import appHTML from "./app.html?raw";

import { open } from "@tauri-apps/plugin-dialog";

import {
  createIcons,
  Folder,
  FolderOpen,
  Lock,
  FileCode,
  FileText,
  FileType,
  FileImage,
  FileBraces,
  FileCog,
  FileArchive,
  FileSpreadsheet,
  FileMusic,
  FilePlay,
  FileTerminal,
  FileQuestionMark,
  FilePlus,
  FolderPlus,
  Pencil,
  FolderInput,
  Trash2,
  RefreshCw,
  GitBranch,
  BookOpen,
  X,
  Terminal,
  ListTree,
  FolderGit2,
  FileDiff,
  GitCommitHorizontal,
  Globe,
  FilePenLine,
  Layers,
} from "lucide";

import Chart from "chart.js/auto";

import { marked } from "marked";

import DOMPurify from "dompurify";

import { renderAsync } from "docx-preview";

import * as pdfjsLib from "pdfjs-dist";

import pdfWorkerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { gitExplanations, gitGuideCategories } from "./gitGuide";

/** Staged (index) and unstaged (working-tree) status values returned by Rust. */
interface GitFileStatus {
  staged: string | null;
  unstaged: string | null;
}

/** Recursive Explorer node containing filesystem metadata, Git status, and children. */
interface TreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  unreadable: boolean;
  status: GitFileStatus | null;
  children: TreeEntry[];
}

/** A single change or context line with optional old and new line numbers. */
interface FileDiffLine {
  old_line_number: number | null;
  new_line_number: number | null;
  line_type: "added" | "removed" | "context";
  content: string;
}

/** Commit identity, author, timestamp (Unix seconds), message, and parent hashes. */
interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
  parents: string[];
}

/** Aggregate repository information shown in the overview and Git Guide. */
interface RepositorySummary {
  current_branch: string | null;
  changed_files: number;
  total_commits: number;
  branch_count: number;
  contributor_count: number;
  latest_commit: string | null;
}

/** Local branch name, HEAD status, and optional tip commit hash. */
interface BranchInfo {
  name: string;
  is_current: boolean;
  commit_hash: string | null;
}

/** Commit together with its computed row and visual lane in the history graph. */
interface GraphCommit {
  commit: CommitInfo;
  row: number;
  lane: number;
}

/** Directed graph edge between a commit and a displayed parent. */
interface GraphConnection {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
}

/** Position in the commit graph SVG coordinate system. */
interface GraphPoint {
  x: number;
  y: number;
}

/** File-level change status and optional addition/deletion statistics. */
interface CommitFileChange {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

/** Timestamp and author of a commit used for activity aggregation. */
interface ActivityCommit {
  timestamp: number;
  author: string;
}

type RepositoryInitMode = "new" | "existing";

type WorkspaceView = "file" | "overview";

// -- Application Setup & Initial State --

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Could not find the app container");
}

app.innerHTML = appHTML;

let mergeCurrentBranch = "";

/** Current Explorer file selection and its most recently loaded metadata. */
let selectedFile: TreeEntry | null = null;

/** Path of the active repository, or null until one has been loaded. */
let currentRepoPath: string | null = null;

let showingDiff = false;

/** Commit lane assignments used to redraw the history graph. */
let currentGraphCommits: GraphCommit[] = [];

/** Parent-child connections in the current commit graph. */
let currentGraphConnections: GraphConnection[] = [];

let activityChart: Chart | null = null;

let currentActivity: ActivityCommit[] = [];

/** Monotonically increasing token used to discard outdated activity responses. */
let activityRequestId = 0;

let isEditing = false;

/** Last loaded or saved text used as the baseline for detecting unsaved edits. */
let originalFileContent = "";

/** Most recent contents of the in-memory text editor. */
let editedFileContent = "";

/** Image Blob URL that must be revoked when changing the selected file. */
let currentImageURL: string | null = null;

let showingMarkdownSource = false;

let showHiddenFiles = false;

let isUnsupportedFile = false;

let contextMenuEntry: TreeEntry | null = null;

let contextMenuIsRoot = false;

let pendingDeleteEntry: TreeEntry | null = null;

let repositoryInitMode: RepositoryInitMode = "new";

/** Last repository tree available to the Git Guide visualization. */
let currentGuideTree: TreeEntry | null = null;

/** Repository statistics available to the Git Guide visualization. */
let currentGuideSummary: RepositorySummary | null = null;

/** Current educational topic used to highlight the guide and diagram. */
let currentGuideTopic: keyof typeof gitExplanations = "welcome";

const graphColors = [
  "#61afef",
  "#50b77a",
  "#d9a441",
  "#e3aa75",
  "#e06c75",
  "#c678dd",
];

// -- Document Object Model (DOM) References --

const treeContainer = document.querySelector<HTMLDivElement>("#tree")!;

const status = document.querySelector<HTMLSpanElement>("#status")!;

const repoName = document.querySelector<HTMLHeadingElement>("#repo-name")!;

const repoBranch = document.querySelector<HTMLSpanElement>("#repo-branch");

const selectButton = document.querySelector<HTMLButtonElement>("#select-repo");

const refreshButton =
  document.querySelector<HTMLButtonElement>("#refresh-repo");

const stageButton = document.querySelector<HTMLButtonElement>("#stage-button");

const commitButton =
  document.querySelector<HTMLButtonElement>("#commit-button");

const commitDialog =
  document.querySelector<HTMLDialogElement>("#commit-dialog");

const commitMessage =
  document.querySelector<HTMLTextAreaElement>("#commit-message");

const cancelCommit =
  document.querySelector<HTMLButtonElement>("#cancel-commit");

const commitStaged =
  document.querySelector<HTMLButtonElement>("#commit-staged");

const commitAll = document.querySelector<HTMLButtonElement>("#commit-all");

const diffToggle = document.querySelector<HTMLInputElement>("#diff-toggle");

const diffToggleContainer = document.querySelector<HTMLLabelElement>(
  "#diff-toggle-container",
);

const overviewButton =
  document.querySelector<HTMLButtonElement>("#overview-button");

const activitySection = document.querySelector<HTMLDetailsElement>(
  "#repository-activity",
);

const createBranchButton = document.querySelector<HTMLButtonElement>(
  "#create-branch-button",
);

const createBranchDialog = document.querySelector<HTMLDialogElement>(
  "#create-branch-dialog",
);

const createBranchForm = document.querySelector<HTMLFormElement>(
  "#create-branch-form",
);

const newBranchName =
  document.querySelector<HTMLInputElement>("#new-branch-name");

const mergeDialog = document.querySelector<HTMLDialogElement>(
  "#merge-branches-dialog",
);

const mergeForm = document.querySelector<HTMLFormElement>(
  "#merge-branches-form",
);

const otherBranchSelect = document.querySelector<HTMLSelectElement>(
  "#merge-other-branch",
);

const cancelMergeButton =
  document.querySelector<HTMLButtonElement>("#cancel-merge");

const editFileButton =
  document.querySelector<HTMLButtonElement>("#edit-file-button");

const cancelEditButton = document.querySelector<HTMLButtonElement>(
  "#cancel-edit-button",
);

const saveFileButton =
  document.querySelector<HTMLButtonElement>("#save-file-button");

const markdownToggle =
  document.querySelector<HTMLInputElement>("#markdown-toggle");

const markdownToggleContainer = document.querySelector<HTMLLabelElement>(
  "#markdown-toggle-container",
);

const hiddenFilesToggle = document.querySelector<HTMLInputElement>(
  "#hidden-files-toggle",
);

const hiddenFilesContainer = document.querySelector<HTMLElement>(
  "#hidden-files-container",
);

const explorerContextMenu = document.querySelector<HTMLDivElement>(
  "#explorer-context-menu",
);

const deleteEntryDialog = document.querySelector<HTMLDialogElement>(
  "#delete-entry-dialog",
);

const deleteEntryMessage = document.querySelector<HTMLParagraphElement>(
  "#delete-entry-message",
);

const cancelDeleteButton = document.querySelector<HTMLButtonElement>(
  "#cancel-delete-button",
);

const confirmDeleteButton = document.querySelector<HTMLButtonElement>(
  "#confirm-delete-button",
);

const initRepositoryDialog = document.querySelector<HTMLDialogElement>(
  "#init-repository-dialog",
);

const initRepositoryDescription = document.querySelector<HTMLElement>(
  "#init-repository-description",
);

const initRepositoryPath = document.querySelector<HTMLInputElement>(
  "#init-repository-path",
);

const initRepositoryName = document.querySelector<HTMLInputElement>(
  "#init-repository-name",
);

const initRepositoryNameContainer = document.querySelector<HTMLElement>(
  "#init-repository-name-container",
);

const initRepositoryBranch = document.querySelector<HTMLInputElement>(
  "#init-repository-branch",
);

const cancelInitButton = document.querySelector<HTMLButtonElement>(
  "#cancel-init-button",
);

const confirmInitButton = document.querySelector<HTMLButtonElement>(
  "#confirm-init-button",
);

const createRepositoryButton = document.querySelector<HTMLButtonElement>(
  "#create-repository-button",
);

const gitGuideButton =
  document.querySelector<HTMLButtonElement>("#git-guide-button");

const gitGuidePanel = document.querySelector<HTMLElement>("#git-guide-panel");

const gitGuideClose =
  document.querySelector<HTMLButtonElement>("#git-guide-close");

const repositoryIdentity = document.querySelector<HTMLElement>(
  ".repository-identity",
);

// -- Shared UI & Icon Helpers --

/** Replaces the repository toolbar, identity, and guide icon placeholders with Lucide SVGs. */
function renderRepositoryToolbarIcons(): void {
  const controls = document.querySelector<HTMLElement>(".repo-controls");

  if (controls) {
    createIcons({
      icons: {
        FolderOpen,
        FolderPlus,
        RefreshCw,
      },
      root: controls,
    });
  }

  const repositoryIdentity = document.querySelector<HTMLElement>(
    ".repository-identity",
  );

  if (repositoryIdentity) {
    createIcons({
      icons: {
        GitBranch,
      },
      root: repositoryIdentity,
    });

    const guidePanel = document.querySelector<HTMLElement>("#git-guide-panel");

    if (guidePanel) {
      createIcons({
        icons: {
          BookOpen,
          X,
          Terminal,
        },
        root: guidePanel,
      });
    }
  }
}

/** Switches the main content panel between the file viewer and repository overview. */
function showWorkspaceView(view: WorkspaceView) {
  const fileView = document.querySelector<HTMLElement>("#file-view");
  const overview = document.querySelector<HTMLElement>("#repository-overview");

  if (!fileView || !overview) return;

  fileView.hidden = view !== "file";
  overview.hidden = view !== "overview";
}

// -- Repository Management --

/**
 * Configures and opens the repository initialization dialog.
 *
 * @param path - The selected parent directory or existing folder.
 * @param mode - Whether to create a new repository directory or initialize the selected one.
 *
 * @remarks
 * Resets the form to a default `main` branch and shows the repository name input only for new directories.
 */
function showInitializeRepositoryDialog(
  path: string,
  mode: RepositoryInitMode,
): void {
  if (
    !initRepositoryDialog ||
    !initRepositoryDescription ||
    !initRepositoryPath ||
    !initRepositoryName ||
    !initRepositoryNameContainer ||
    !initRepositoryBranch
  ) {
    return;
  }

  repositoryInitMode = mode;

  initRepositoryPath.value = path;
  initRepositoryBranch.value = "main";
  initRepositoryName.value = "";

  const isNew = mode === "new";

  initRepositoryNameContainer.hidden = !isNew;

  initRepositoryDescription.textContent = isNew
    ? "Create a new Git repository in a subfolder of the selected directory."
    : "This folder is not a Git repository. Would you like to initialize it?";

  initRepositoryDialog.showModal();
}

/**
 * Loads repository data and refreshes the Explorer, overview, and Git Guide.
 *
 * @param path - Filesystem path of the repository to load.
 *
 * @remarks
 * Fetches the directory tree, summary, commit history, and branches in sequence, then starts activity loading without awaiting it. Preserves expanded directories when refreshing the same repository and attempts to reselect the previously opened file. Updates shared state and displays errors in the UI.
 *
 * @returns Resolves after the requested updates complete; no data is returned.
 */
async function loadRepository(path: string) {
  status.textContent = "Refreshing repository…";
  status.classList.remove("success");
  const summary = document.querySelector<HTMLDivElement>(
    "#repo-status-summary",
  );
  summary?.replaceChildren();
  try {
    const root = await invoke<TreeEntry>("get_repository_tree", {
      path: path,
      showHidden: showHiddenFiles,
    });

    const repositorySummary = await loadRepositorySummary(path);
    await loadCommitHistory(path);
    await loadLocalBranches(path);
    void loadRepositoryActivity(path);

    const selectedPath = selectedFile?.path;

    currentGuideTree = root;
    currentGuideSummary = repositorySummary;
    renderGitGuideVisual(gitExplanations[currentGuideTopic].visual);

    // Preserve folder expansion only when refreshing the currently open repository.
    const expandedDirectories =
      currentRepoPath === path ? getExpandedDirectories() : new Set<string>();

    repoName.textContent = root.name || "Repository";
    currentRepoPath = path;

    if (repoBranch) {
      repoBranch.textContent = repositorySummary?.current_branch ?? "No branch";
    }

    if (commitButton) {
      commitButton.disabled = true;
    }

    if (hiddenFilesContainer) {
      hiddenFilesContainer.hidden = false;
    }

    treeContainer.replaceChildren(renderEntry(root, true, expandedDirectories));

    renderTreeIcons();
    renderStatusSummary(root);

    // Rebind the selection to the newly fetched tree instead of retaining stale metadata.
    if (selectedPath) {
      const updatedFile = findFileByPath(root, selectedPath);

      const fileElement = Array.from(
        treeContainer.querySelectorAll<HTMLElement>(".file"),
      ).find((element) => element.dataset.path === selectedPath);

      if (updatedFile && fileElement) {
        await openFile(updatedFile, fileElement);
      } else {
        selectedFile = null;
        updateStageButton(null);
      }
    }

    const repoPath = document.querySelector<HTMLSpanElement>("#repo-path");

    if (repoPath) {
      repoPath.textContent = path;
      repoPath.title = path;
    }

    status.textContent = "Repository loaded";
    status.classList.add("success");

    if (refreshButton) {
      refreshButton.disabled = false;
    }

    if (overviewButton) {
      overviewButton.disabled = false;
    }
  } catch (error) {
    status.textContent = "Failed to load repository";
    console.error("Failed to load repository:", error);
    if (refreshButton && !currentRepoPath) {
      refreshButton.disabled = true;
    }
    if (overviewButton && !currentRepoPath) {
      overviewButton.disabled = true;
    }
    treeContainer.textContent = String(error);
  }
}

/**
 * Retrieves summary statistics and updates the repository overview.
 *
 * @param repoPath - Filesystem path of the repository.
 *
 * @remarks
 * Displays branch, commit, contributor, and changed-file counts, along with the latest commit. Missing UI elements or backend errors result in `null`.
 *
 * @returns The retrieved summary, or `null` if it cannot be displayed.
 */
async function loadRepositorySummary(
  repoPath: string,
): Promise<RepositorySummary | null> {
  const commits = document.querySelector<HTMLElement>("#summary-commits");
  const branches = document.querySelector<HTMLElement>("#summary-branches");
  const contributors = document.querySelector<HTMLElement>(
    "#summary-contributors",
  );
  const currentBranch = document.querySelector<HTMLElement>(
    "#summary-current-branch",
  );
  const changes = document.querySelector<HTMLElement>("#summary-changes");
  const latestCommit = document.querySelector<HTMLElement>(
    "#summary-latest-commit",
  );

  if (
    !commits ||
    !branches ||
    !contributors ||
    !currentBranch ||
    !changes ||
    !latestCommit
  ) {
    return null;
  }

  try {
    const summary = await invoke<RepositorySummary>("get_repository_summary", {
      repoPath,
    });
    commits.textContent = summary.total_commits.toLocaleString();
    branches.textContent = summary.branch_count.toLocaleString();
    contributors.textContent = summary.contributor_count.toLocaleString();
    currentBranch.textContent =
      summary.current_branch ?? "Detached HEAD / No commits";
    changes.textContent =
      summary.changed_files === 0
        ? "Clean"
        : `${summary.changed_files} changed file${summary.changed_files === 1 ? "" : "s"}`;
    latestCommit.textContent = summary.latest_commit
      ? summary.latest_commit.substring(0, 7)
      : "No commits";
    if (summary.latest_commit) {
      latestCommit.title = summary.latest_commit;
    }
    return summary;
  } catch (error) {
    console.error("Failed to load repository summary:", error);
    return null;
  }
}

// -- File Explorer & File Statuses --

/**
 * Counts changed files within a file or directory tree.
 *
 * @param entry - Tree node to inspect.
 *
 * @remarks
 * Counts each changed file once even if it has both staged and unstaged changes.
 *
 * @returns Number of changed file nodes.
 */
function countChangedFiles(entry: TreeEntry): number {
  if (!entry.is_dir) {
    return entry.status?.staged || entry.status?.unstaged ? 1 : 0;
  }

  return entry.children.reduce(
    (total, child) => total + countChangedFiles(child),
    0,
  );
}

/**
 * Finds a file with a matching absolute path in a repository tree.
 *
 * @param entry - Node at which to begin the recursive search.
 * @param path - Filesystem path to match.
 *
 * @returns The matching file entry, or `null`.
 */
function findFileByPath(entry: TreeEntry, path: string): TreeEntry | null {
  if (!entry.is_dir && entry.path === path) {
    return entry;
  }
  for (const child of entry.children) {
    const found = findFileByPath(child, path);
    if (found) return found;
  }
  return null;
}

/** Selects a Lucide icon name for a filename based on recognized names and extensions. */
function getFileIcon(filename: string): string {
  const name = filename.toLowerCase();
  const extension = name.split(".").pop() ?? "";

  if (["dockerfile", "makefile", "justfile"].includes(name)) {
    return "file-terminal";
  }

  if (name === ".gitignore" || name === ".gitattributes") {
    return "file-cog";
  }

  if (name === "license" || name === "license.md") {
    return "file-text";
  }

  // I don't love switch cases, but this is just far more readable
  switch (extension) {
    case "rs":
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "java":
    case "c":
    case "cpp":
    case "h":
    case "cs":
    case "go":
    case "sh":
      return "file-code";

    case "html":
    case "css":
    case "scss":
      return "file-code";

    case "md":
    case "markdown":
    case "txt":
    case "log":
    case "doc":
    case "docx":
    case "odt":
    case "rtf":
      return "file-text";

    case "pdf":
      return "file-type";

    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
    case "ico":
      return "file-image";

    case "json":
    case "jsonc":
      return "file-braces";

    case "toml":
    case "yaml":
    case "yml":
    case "xml":
    case "ini":
      return "file-cog";

    case "zip":
    case "tar":
    case "gz":
    case "7z":
    case "rar":
      return "file-archive";

    case "csv":
    case "xlsx":
    case "xls":
    case "ods":
      return "file-spreadsheet";

    case "mp3":
    case "wav":
    case "ogg":
    case "flac":
      return "file-music";

    case "mp4":
    case "webm":
    case "mov":
      return "file-play";

    default:
      return "file-question-mark";
  }
}

/** Converts icon placeholders in the Explorer and context menu into Lucide icons. */
function renderTreeIcons(): void {
  const tree = document.querySelector<HTMLElement>("#tree");
  if (!tree) return;
  createIcons({
    icons: {
      Folder,
      FolderOpen,
      Lock,
      FileCode,
      FileText,
      FileType,
      FileImage,
      FileBraces,
      FileCog,
      FileArchive,
      FileSpreadsheet,
      FileMusic,
      FilePlay,
      FileTerminal,
      FileQuestionMark,
    },
    root: tree,
  });
  if (explorerContextMenu) {
    createIcons({
      icons: {
        FilePlus,
        FolderPlus,
        Pencil,
        FolderInput,
        Trash2,
      },
      root: explorerContextMenu,
    });
  }
}

/**
 * Recursively creates the Explorer DOM for a repository tree node.
 *
 * @param entry - File or directory entry to render.
 * @param isRoot - Whether the entry is the root of the Explorer.
 * @param expandedDirectories - Paths to restore as expanded during refresh.
 *
 * @remarks
 * Directory nodes use expandable `details` elements and render children recursively. File nodes register click and context-menu actions. Both kinds show staged and unstaged status indicators; unreadable directories are not expanded.
 *
 * @returns The DOM element representing the entry.
 */
function renderEntry(
  entry: TreeEntry,
  isRoot = false,
  expandedDirectories: Set<string> = new Set(),
): HTMLElement {
  if (entry.is_dir) {
    const details = document.createElement("details");
    details.className = "directory";
    details.dataset.path = entry.path;
    details.open =
      !entry.unreadable && (isRoot || expandedDirectories.has(entry.path));

    const summary = document.createElement("summary");
    const icon = document.createElement("i");
    summary.addEventListener("contextmenu", (event) => {
      showExplorerContextMenu(event, entry, isRoot);
    });

    icon.setAttribute(
      "data-lucide",
      entry.unreadable ? "lock" : details.open ? "folder-open" : "folder",
    );
    icon.className = "tree-icon";
    summary.appendChild(icon);
    const label = document.createTextNode(
      entry.unreadable
        ? ` ${entry.name} (Access denied)`
        : ` ${entry.name || "Repository root"}`,
    );
    summary.appendChild(label);

    const changedFiles = countChangedFiles(entry);

    if (changedFiles > 0) {
      const count = document.createElement("span");
      count.className = "directory-change-count";
      count.textContent = String(changedFiles);
      count.title = `${changedFiles} changed file${changedFiles === 1 ? "" : "s"}`;
      summary.appendChild(count);
    }

    if (entry.status?.staged) {
      const indicator = createStatusIndicator(entry.status.staged);
      if (indicator) {
        indicator.title = `Staged: ${entry.status.staged}`;
        summary.appendChild(indicator);
      }
    }

    if (entry.status?.unstaged) {
      const indicator = createStatusIndicator(entry.status.unstaged);
      if (indicator) {
        indicator.title = `Unstaged: ${entry.status.unstaged}`;
        summary.appendChild(indicator);
      }
    }

    summary.title = entry.path || ".";
    if (entry.unreadable) {
      summary.classList.add("unreadable");
    }

    const children = document.createElement("div");
    children.className = "children";
    for (const child of entry.children) {
      children.appendChild(renderEntry(child, false, expandedDirectories));
    }
    details.append(summary, children);
    details.addEventListener("toggle", () => {
      if (entry.unreadable) return;

      const iconName = details.open ? "folder-open" : "folder";

      const newIcon = document.createElement("i");
      newIcon.setAttribute("data-lucide", iconName);
      newIcon.className = "tree-icon";

      const oldIcon = summary.querySelector(".tree-icon");
      oldIcon?.replaceWith(newIcon);

      createIcons({
        icons: { Folder, FolderOpen },
        root: summary,
      });
    });
    return details;
  }

  const file = document.createElement("div");
  file.className = "file";
  file.dataset.path = entry.path;
  file.addEventListener("click", () => {
    void openFile(entry, file);
  });
  file.addEventListener("contextmenu", (event) => {
    showExplorerContextMenu(event, entry, false);
  });

  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", getFileIcon(entry.name));
  icon.className = "tree-icon";

  file.appendChild(icon);
  file.appendChild(document.createTextNode(` ${entry.name}`));
  if (entry.status?.staged) {
    const indicator = createStatusIndicator(entry.status.staged);
    if (indicator) {
      indicator.title = `Staged: ${entry.status.staged}`;
      file.appendChild(indicator);
    }
  }

  if (entry.status?.unstaged) {
    const indicator = createStatusIndicator(entry.status.unstaged);
    if (indicator) {
      indicator.title = `Unstaged: ${entry.status.unstaged}`;
      file.appendChild(indicator);
    }
  }

  file.title = entry.path;

  return file;
}

/** Collects currently expanded directory paths so refreshes can preserve the tree view. */
function getExpandedDirectories(): Set<string> {
  const expanded = new Set<string>();

  treeContainer
    .querySelectorAll<HTMLDetailsElement>("details.directory[open]")
    .forEach((details) => {
      if (details.dataset.path !== undefined) {
        expanded.add(details.dataset.path);
      }
    });

  return expanded;
}

/** Creates a compact badge for a Git status value. */
function createStatusIndicator(status: string | null): HTMLElement | null {
  if (!status) return null;

  const indicator = document.createElement("span");
  indicator.className = `git-status git-status-${status}`;

  const labels: Record<string, string> = {
    modified: "M",
    added: "A",
    untracked: "U",
    deleted: "D",
    renamed: "R",
    conflicted: "!",
  };

  const descriptions: Record<string, string> = {
    modified: "Modified",
    added: "Added",
    untracked: "Untracked",
    deleted: "Deleted",
    renamed: "Renamed",
    conflicted: "Conflicted",
  };

  indicator.textContent = labels[status] ?? "?";
  indicator.title = descriptions[status] ?? status;

  return indicator;
}

/**
 * Counts staged and unstaged status occurrences throughout the tree.
 *
 * @param root - Root of the repository tree.
 *
 * @remarks
 * A file may contribute to both staged and unstaged totals because Git tracks index and working-tree changes separately.
 *
 * @returns Counts keyed by area and status, such as `staged-modified`.
 */
function getStatusCounts(root: TreeEntry): Record<string, number> {
  const counts: Record<string, number> = {};

  function visit(entry: TreeEntry) {
    if (entry.status?.staged) {
      const status = `staged-${entry.status.staged}`;
      counts[status] = (counts[status] ?? 0) + 1;
    }

    if (entry.status?.unstaged) {
      const status = `unstaged-${entry.status.unstaged}`;
      counts[status] = (counts[status] ?? 0) + 1;
    }

    for (const child of entry.children) {
      visit(child);
    }
  }

  visit(root);
  return counts;
}

/**
 * Displays Git status totals beside the repository heading.
 *
 * @param root - Repository tree used to calculate status counts.
 *
 * @remarks
 * Renders indicators in a fixed order and enables the commit button when at least one recognized status count is present.
 */
function renderStatusSummary(root: TreeEntry) {
  const summary = document.querySelector<HTMLDivElement>(
    "#repo-status-summary",
  );
  if (!summary) return;

  summary.replaceChildren();

  const counts = getStatusCounts(root);

  const labels: Record<string, string> = {
    modified: "M",
    added: "A",
    untracked: "U",
    deleted: "D",
    renamed: "R",
    conflicted: "!",
  };

  const order = [
    "staged-modified",
    "staged-added",
    "staged-deleted",
    "staged-renamed",
    "staged-conflicted",
    "unstaged-modified",
    "unstaged-added",
    "unstaged-untracked",
    "unstaged-deleted",
    "unstaged-renamed",
    "unstaged-conflicted",
  ];

  for (const key of order) {
    const count = counts[key];

    if (!count) continue;

    if (commitButton) {
      commitButton.disabled = false;
    }

    const [area, status] = key.split("-");

    const item = document.createElement("span");
    item.className = `git-status git-status-${status}`;
    item.textContent = `${area === "staged" ? "S" : "U"}${labels[status]} ${count}`;
    item.title = `${count} ${area} ${status} file${count === 1 ? "" : "s"}`;

    summary.appendChild(item);
  }
}

// -- File Management & Menus --

/**
 * Opens the Explorer context menu for a selected entry.
 *
 * @param event - Context-menu mouse event determining the menu position.
 * @param entry - Explorer entry associated with the menu.
 * @param isRoot - Whether the selected entry is the repository root.
 *
 * @remarks
 * Stores the target entry, disables destructive root actions, and clamps the menu position to the visible window.
 */
function showExplorerContextMenu(
  event: MouseEvent,
  entry: TreeEntry,
  isRoot: boolean,
): void {
  event.preventDefault();
  event.stopPropagation();

  if (!explorerContextMenu) return;

  contextMenuEntry = entry;
  contextMenuIsRoot = isRoot;
  explorerContextMenu
    .querySelectorAll<HTMLButtonElement>(
      '[data-action="rename"], [data-action="move"], [data-action="delete"]',
    )
    .forEach((button) => {
      button.disabled = isRoot;
    });

  explorerContextMenu.hidden = false;

  const rect = explorerContextMenu.getBoundingClientRect();

  explorerContextMenu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - rect.width))}px`;

  explorerContextMenu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - rect.height))}px`;
}

/** Hides the Explorer context menu and clears its stored target. */
function hideExplorerContextMenu(): void {
  if (!explorerContextMenu) return;

  explorerContextMenu.hidden = true;
  contextMenuEntry = null;
  contextMenuIsRoot = false;
}

/**
 * Prompts for a new file or folder name and asks Rust to create it.
 *
 * @param entry - Selected file or parent directory.
 * @param isDirectory - Whether to create a directory instead of a file.
 *
 * @remarks
 * Rejects creation while there are unsaved editor changes and refreshes the repository after success. The Rust command performs authoritative path validation.
 */
async function createExplorerEntry(
  entry: TreeEntry,
  isDirectory: boolean,
): Promise<void> {
  if (!currentRepoPath) return;

  if (isEditing && editedFileContent !== originalFileContent) {
    alert("Please save or cancel your current edits before creating files.");
    return;
  }

  const parentPath = entry.is_dir
    ? entry.path
    : entry.path.replace(/[\\/][^\\/]+$/, "");

  const name = prompt(isDirectory ? "New folder name:" : "New file name:");

  if (name === null) return;

  if (!name.trim()) {
    alert("Please enter a valid name.");
    return;
  }

  try {
    await invoke("create_entry", {
      repoPath: currentRepoPath,
      parentPath,
      name,
      isDirectory,
    });

    await loadRepository(currentRepoPath);
  } catch (error) {
    alert(`Failed to create entry: ${error}`);
  }
}

/**
 * Prompts for a new name and invokes the repository rename command.
 *
 * @param entry - Explorer entry to rename.
 *
 * @remarks
 * Blocks the operation when editor changes are unsaved, then refreshes the Explorer on success.
 */
async function renameExplorerEntry(entry: TreeEntry): Promise<void> {
  if (!currentRepoPath) return;

  if (isEditing && editedFileContent !== originalFileContent) {
    alert("Please save or cancel your current edits before renaming files.");
    return;
  }

  const newName = prompt("Rename to:", entry.name);

  if (newName === null || newName === entry.name) {
    return;
  }

  if (!newName.trim()) {
    alert("Please enter a valid name.");
    return;
  }

  try {
    await invoke("rename_entry", {
      repoPath: currentRepoPath,
      entryPath: entry.path,
      newName,
    });

    await loadRepository(currentRepoPath);
  } catch (error) {
    alert(`Failed to rename entry: ${error}`);
  }
}

/**
 * Moves the selected Explorer entry into a chosen directory.
 *
 * @param entry - File or folder to move.
 *
 * @remarks
 * Uses a native directory picker, invokes Rust to validate and perform the move, and clears the file selection when it refers to the moved entry or a descendant.
 */
async function moveExplorerEntry(entry: TreeEntry): Promise<void> {
  if (!currentRepoPath) return;

  if (isEditing && editedFileContent !== originalFileContent) {
    alert("Please save or cancel your edits before moving files.");
    return;
  }

  const repoPath = currentRepoPath;

  try {
    const destination = await open({
      directory: true,
      multiple: false,
      title: `Move "${entry.name}" to...`,
      defaultPath: entry.path,
    });

    if (!destination) return;

    await invoke("move_entry", {
      repoPath,
      entryPath: entry.path,
      destinationPath: destination,
    });

    if (
      selectedFile &&
      (selectedFile.path === entry.path ||
        (entry.is_dir &&
          selectedFile.path.startsWith(
            entry.path.replace(/[\\/]$/, "") +
              (entry.path.includes("\\") ? "\\" : "/"),
          )))
    ) {
      selectedFile = null;
    }

    await loadRepository(repoPath);
  } catch (error) {
    alert(`Failed to move entry: ${error}`);
  }
}

/**
 * Displays a confirmation dialog for permanently deleting an Explorer entry.
 *
 * @param entry - File or directory selected for deletion.
 *
 * @remarks
 * Warns that deleting a directory also removes nested files, including hidden and untracked entries. Rejects deletion while unsaved edits exist.
 */
function showDeleteConfirmation(entry: TreeEntry): void {
  if (!deleteEntryDialog || !deleteEntryMessage) return;

  if (isEditing && editedFileContent !== originalFileContent) {
    alert("Please save or cancel your edits before deleting files.");
    return;
  }

  pendingDeleteEntry = entry;

  if (entry.is_dir) {
    deleteEntryMessage.textContent =
      `Permanently delete the folder "${entry.name}"? ` +
      `This will also delete ALL files and subfolders inside it, ` +
      `including hidden, ignored, and untracked files.`;
  } else {
    deleteEntryMessage.textContent = `Permanently delete the file "${entry.name}"?`;
  }

  deleteEntryDialog.showModal();
}

/**
 * Deletes the specified file or directory through the Rust backend.
 *
 * @param entry - Entry to delete.
 *
 * @remarks
 * Clears the selected file when the deleted entry contains it, and refreshes the repository after successful deletion.
 */
async function deleteExplorerEntry(entry: TreeEntry): Promise<void> {
  if (!currentRepoPath) return;

  try {
    await invoke("delete_entry", {
      repoPath: currentRepoPath,
      entryPath: entry.path,
    });

    if (
      selectedFile &&
      (selectedFile.path === entry.path ||
        (entry.is_dir &&
          selectedFile.path.startsWith(
            entry.path.replace(/[\\/]$/, "") +
              (entry.path.includes("\\") ? "\\" : "/"),
          )))
    ) {
      selectedFile = null;
    }
    await loadRepository(currentRepoPath);
  } catch (error) {
    alert(`Failed to delete entry: ${error}`);
  }
}

// -- File Viewing & Editing --

/** Checks whether a filename has a Markdown extension. */
function isMarkdownFile(filename: string): boolean {
  const extension = filename.toLowerCase();

  return extension.endsWith(".md") || extension.endsWith(".markdown");
}

/** Checks whether a filename uses a supported image extension. */
function isImageFile(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(filename);
}

/** Checks whether a filename ends in `.pdf`. */
function isPDFFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}

/** Checks whether a filename ends in `.docx`. */
function isDOCXFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(".docx");
}

/**
 * Updates the Edit, Save, and Cancel controls to match editor state.
 *
 * @remarks
 * Disables editing for unsupported files, image/PDF/DOCX previews, and diff mode. Save is enabled only when the editor contains unsaved changes.
 */
function updateEditingButtons() {
  if (!editFileButton || !cancelEditButton || !saveFileButton) {
    return;
  }

  editFileButton.hidden =
    !selectedFile ||
    isUnsupportedFile ||
    isImageFile(selectedFile.name) ||
    isPDFFile(selectedFile.name) ||
    isDOCXFile(selectedFile.name) ||
    isEditing ||
    showingDiff;

  cancelEditButton.hidden = !isEditing;
  saveFileButton.hidden = !isEditing;

  saveFileButton.disabled =
    !isEditing || editedFileContent === originalFileContent;
}

/**
 * Shows and synchronizes the diff toggle for the selected file.
 *
 * @param entry - Current file entry, or `null` when no file is selected.
 *
 * @remarks
 * The toggle is hidden for unchanged files and supported non-text preview formats.
 */
function updateDiffToggle(entry: TreeEntry | null) {
  if (!diffToggle || !diffToggleContainer) return;

  const hasChanges = Boolean(entry?.status?.staged || entry?.status?.unstaged);

  diffToggleContainer.hidden =
    !hasChanges ||
    Boolean(
      entry &&
      (isImageFile(entry.name) ||
        isPDFFile(entry.name) ||
        isDOCXFile(entry.name)),
    );
  diffToggle.checked = hasChanges && showingDiff;
}

/** Shows the Markdown source toggle only when Markdown preview is available. */
function updateMarkdownToggle(): void {
  if (!markdownToggle || !markdownToggleContainer) return;

  const isMarkdown = selectedFile !== null && isMarkdownFile(selectedFile.name);

  markdownToggleContainer.hidden = !isMarkdown || isEditing || showingDiff;

  markdownToggle.checked = showingMarkdownSource;
}

/** Asks for confirmation before discarding unsaved editor changes. */
function confirmDiscardEdits(): boolean {
  if (!isEditing || editedFileContent === originalFileContent) {
    return true;
  }
  return window.confirm("You have unsaved changes. Discard them?");
}

/**
 * Replaces the current text preview with an editable text area.
 *
 * @remarks
 * Initializes the editor from the original content, tracks input changes, and updates the available editing controls.
 */
function startFileEditing() {
  if (!selectedFile || isEditing || showingDiff) return;

  const fileContent = document.querySelector<HTMLDivElement>("#file-content");

  if (!fileContent) return;

  isEditing = true;
  editedFileContent = originalFileContent;

  const editor = document.createElement("textarea");

  editor.id = "file-editor";
  editor.className = "file-editor";
  editor.value = editedFileContent;

  editor.spellcheck = false;
  editor.wrap = "soft";

  editor.addEventListener("input", () => {
    editedFileContent = editor.value;
    updateEditingButtons();
  });

  fileContent.replaceChildren(editor);

  editor.focus();

  updateEditingButtons();
  updateMarkdownToggle();
}

/**
 * Selects and displays an Explorer file using the appropriate preview or editor mode.
 *
 * @param entry - Selected file metadata from the repository tree.
 * @param element - Explorer element to mark as selected.
 *
 * @remarks
 * Prompts before discarding unsaved edits, revokes a previous image object URL, and resets file-view state. Image, PDF, DOCX, and UTF-8 text use different backend reads and renderers. Image and document loads check whether the file selection changed while awaiting data; unsupported binary text displays a fallback view.
 *
 * @returns Resolves after the selected preview path finishes; errors are shown in the file view.
 */
async function openFile(entry: TreeEntry, element: HTMLElement) {
  if (!currentRepoPath) return;

  const fileName = document.querySelector<HTMLHeadingElement>("#file-name");
  const filePath = document.querySelector<HTMLParagraphElement>("#file-path");
  const fileContent = document.querySelector<HTMLDivElement>("#file-content");

  if (!fileName || !filePath || !fileContent) return;

  if (isEditing && editedFileContent !== originalFileContent) {
    const confirmed = window.confirm(
      "You have unsaved changes. Discard them and open another file?",
    );

    if (!confirmed) return;
  }

  isUnsupportedFile = false;

  if (currentImageURL) {
    URL.revokeObjectURL(currentImageURL);
    currentImageURL = null;
  }

  document.querySelectorAll(".file.selected").forEach((file) => {
    file.classList.remove("selected");
  });

  element.classList.add("selected");

  selectedFile = entry;
  showingDiff = false;
  updateDiffToggle(entry);
  updateStageButton(entry);
  showWorkspaceView("file");
  isEditing = false;
  editFileButton && (editFileButton.hidden = true);
  cancelEditButton && (cancelEditButton.hidden = true);
  saveFileButton && (saveFileButton.hidden = true);

  fileName.textContent = entry.name;
  filePath.textContent = entry.path;
  fileContent.textContent = "Loading file...";

  try {
    if (isImageFile(entry.name)) {
      const imageURL = await loadLocalImage(currentRepoPath, entry.path);

      if (selectedFile !== entry) {
        URL.revokeObjectURL(imageURL);
        return;
      }

      currentImageURL = imageURL;
      renderImage(imageURL, fileContent);

      isEditing = false;
      originalFileContent = "";
      editedFileContent = "";

      updateEditingButtons();
      return;
    }
    if (isPDFFile(entry.name)) {
      isEditing = false;
      originalFileContent = "";
      editedFileContent = "";

      updateEditingButtons();

      const bytes = await invoke<number[]>("read_document", {
        repoPath: currentRepoPath,
        filePath: entry.path,
      });

      if (selectedFile !== entry) return;

      await renderPDF(bytes, fileContent);

      return;
    }
    if (isDOCXFile(entry.name)) {
      isEditing = false;
      originalFileContent = "";
      editedFileContent = "";

      updateEditingButtons();

      const bytes = await invoke<number[]>("read_document", {
        repoPath: currentRepoPath,
        filePath: entry.path,
      });

      if (selectedFile !== entry) return;

      await renderDOCX(bytes, fileContent, () => selectedFile === entry);

      return;
    }
    let contents: string;

    try {
      contents = await invoke<string>("read_file", {
        repoPath: currentRepoPath,
        filePath: entry.path,
      });
    } catch (error) {
      if (String(error).includes("UNSUPPORTED_BINARY_FILE")) {
        isUnsupportedFile = true;
        renderUnsupportedFile(entry.name, fileContent);

        isEditing = false;
        originalFileContent = "";
        editedFileContent = "";

        updateEditingButtons();
        updateMarkdownToggle();

        return;
      }

      throw error;
    }

    originalFileContent = contents;
    editedFileContent = contents;
    isEditing = false;

    showingMarkdownSource = false;

    updateEditingButtons();
    updateMarkdownToggle();

    if (isMarkdownFile(entry.name)) {
      renderCurrentMarkdownView();
    } else {
      renderPlainText(contents, fileContent);
    }

    if (isMarkdownFile(entry.name)) {
      renderMarkdown(contents, fileContent);
      return;
    }

    const pre = document.createElement("pre");
    pre.className = "file-text";

    const lines = contents.split("\n");

    lines.forEach((line, index) => {
      const lineElement = document.createElement("div");
      lineElement.className = "file-line";

      const lineNumber = document.createElement("span");
      lineNumber.className = "line-number";
      lineNumber.textContent = String(index + 1);

      const lineContent = document.createElement("span");
      lineContent.className = "line-content";
      lineContent.textContent = line;

      lineElement.append(lineNumber, lineContent);
      pre.appendChild(lineElement);
    });

    fileContent.replaceChildren(pre);
  } catch (error) {
    fileContent.textContent = `Unable to open file: ${error}`;
  }
}

/** Renders text content as separate lines with line-number gutters. */
function renderPlainText(contents: string, container: HTMLElement): void {
  const pre = document.createElement("pre");
  pre.className = "file-text";

  const lines = contents.split("\n");

  lines.forEach((line, index) => {
    const lineElement = document.createElement("div");
    lineElement.className = "file-line";

    const lineNumber = document.createElement("span");
    lineNumber.className = "line-number";
    lineNumber.textContent = String(index + 1);

    const lineContent = document.createElement("span");
    lineContent.className = "line-content";
    lineContent.textContent = line;

    lineElement.append(lineNumber, lineContent);
    pre.appendChild(lineElement);
  });

  container.replaceChildren(pre);
}

/**
 * Renders the selected Markdown file as source text or formatted preview.
 *
 * @remarks
 * Uses the source toggle state and the last loaded text contents; updates the toggle after rendering.
 */
function renderCurrentMarkdownView(): void {
  if (!selectedFile || !isMarkdownFile(selectedFile.name)) {
    return;
  }

  const fileContent = document.querySelector<HTMLElement>("#file-content");

  if (!fileContent) return;

  if (showingMarkdownSource) {
    renderPlainText(originalFileContent, fileContent);
  } else {
    renderMarkdown(originalFileContent, fileContent);
  }

  updateMarkdownToggle();
}

/**
 * Converts Markdown text into a sanitized HTML preview.
 *
 * @param contents - Markdown source text.
 * @param container - Element to receive the rendered preview.
 *
 * @remarks
 * Parses GitHub-flavored Markdown, sanitizes generated HTML, removes image sources other than absolute HTTP(S) URLs, and strips link destinations before inserting the preview.
 */
function renderMarkdown(contents: string, container: HTMLElement): void {
  const html = marked.parse(contents, {
    async: false,
    gfm: true,
    breaks: false,
  });

  // Sanitize generated markup before inserting it into the application DOM.
  const sanitizedHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  });

  const preview = document.createElement("div");
  preview.className = "markdown-preview";

  preview.innerHTML = sanitizedHTML;

  preview.querySelectorAll("img").forEach((image) => {
    const source = image.getAttribute("src");

    if (!source) {
      image.remove();
      return;
    }

    try {
      const url = new URL(source);

      if (url.protocol !== "https:" && url.protocol !== "http:") {
        image.remove();
      }
    } catch {
      image.remove();
    }
  });

  // Render linked text without navigating away from the local application.
  preview.querySelectorAll("a").forEach((link) => {
    link.removeAttribute("href");
  });

  container.replaceChildren(preview);
}

/**
 * Loads image bytes from Rust and creates a browser object URL.
 *
 * @param repoPath - Repository containing the image.
 * @param filePath - Path of the image file.
 *
 * @remarks
 * Maps supported extensions to MIME types and wraps the returned bytes in a Blob. Callers must revoke the returned object URL when it is no longer used.
 *
 * @returns Object URL for the loaded image.
 *
 * @throws Throws if the backend read fails or the extension is unsupported.
 */
async function loadLocalImage(
  repoPath: string,
  filePath: string,
): Promise<string> {
  const bytes = await invoke<number[]>("read_image", {
    repoPath,
    filePath,
  });

  const extension = filePath.split(".").pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };

  const mimeType = mimeTypes[extension ?? ""];

  if (!mimeType) {
    throw new Error("Unsupported image format.");
  }

  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });

  return URL.createObjectURL(blob);
}

/** Inserts an image preview using a supplied object URL. */
function renderImage(url: string, container: HTMLElement): void {
  const image = document.createElement("img");

  image.src = url;
  image.className = "file-image";
  image.alt = "Image preview";

  container.replaceChildren(image);
}

/**
 * Renders every page of a PDF into a canvas inside the file viewer.
 *
 * @param bytes - PDF file bytes returned by Rust.
 * @param container - Element to receive the rendered pages.
 *
 * @remarks
 * PDF.js decodes the document and renders pages sequentially at 1.5× viewport scale. Replacing the viewer contents happens before page rendering completes.
 *
 * @returns Resolves when all pages have rendered.
 *
 * @throws Rejects if PDF decoding, page rendering, or canvas creation fails.
 */
async function renderPDF(
  bytes: number[],
  container: HTMLElement,
): Promise<void> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
  });

  const pdf = await loadingTask.promise;

  const viewer = document.createElement("div");
  viewer.className = "pdf-viewer";

  container.replaceChildren(viewer);

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);

    const viewport = page.getViewport({ scale: 1.5 });

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Unable to create PDF canvas.");
    }

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    canvas.className = "pdf-page";

    viewer.appendChild(canvas);

    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise;
  }
}

/**
 * Renders a DOCX file into the document preview.
 *
 * @param bytes - DOCX file bytes returned by Rust.
 * @param container - Element to receive the document.
 * @param isCurrent - Callback indicating whether the same file remains selected.
 *
 * @remarks
 * The document is first rendered in a detached element, then inserted only if the selection is still current. Page structure, headers, footers, and footnotes are enabled.
 *
 * @returns Resolves after rendering and the selection check.
 *
 * @throws Rejects if the DOCX rendering library fails.
 */
async function renderDOCX(
  bytes: number[],
  container: HTMLElement,
  isCurrent: () => boolean,
): Promise<void> {
  const viewer = document.createElement("div");
  viewer.className = "docx-viewer";

  await renderAsync(new Uint8Array(bytes), viewer, undefined, {
    inWrapper: true,
    breakPages: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    useBase64URL: true,
  });

  // Rendering may finish after the user selects another file.
  if (!isCurrent()) return;

  container.replaceChildren(viewer);
}

/** Shows a fallback message for a file that cannot be previewed. */
function renderUnsupportedFile(filename: string, container: HTMLElement): void {
  const message = document.createElement("div");
  message.className = "unsupported-file";

  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", "file-question-mark");
  icon.className = "unsupported-file-icon";

  const heading = document.createElement("h3");
  heading.textContent = "Preview unavailable";

  const description = document.createElement("p");
  description.textContent =
    "Clairvoyance cannot preview this file as text or a supported document format.";

  const filenameLabel = document.createElement("span");
  filenameLabel.className = "muted";
  filenameLabel.textContent = filename;

  message.append(icon, heading, description, filenameLabel);
  container.replaceChildren(message);
  createIcons({
    icons: { FileQuestionMark },
    attrs: {
      width: 36,
      height: 36,
    },
  });
}

// -- Git Opertaions & Branches --

/**
 * Updates the stage/unstage action for the selected Git file.
 *
 * @param entry - Selected file, or `null`.
 *
 * @remarks
 * Prefers unstaged changes when both areas contain changes; disables the action for conflicted files and unstaged deletions.
 */
function updateStageButton(entry: TreeEntry | null) {
  if (!stageButton) return;

  if (entry?.status?.unstaged) {
    stageButton.hidden = false;
    stageButton.textContent = "Stage File";
    stageButton.disabled =
      entry.status.unstaged === "deleted" ||
      entry.status.unstaged === "conflicted";
  } else if (entry?.status?.staged) {
    stageButton.hidden = false;
    stageButton.textContent = "Unstage File";
    stageButton.disabled = entry.status.staged === "conflicted";
  } else {
    stageButton.hidden = true;
  }
}

/** Enables commit actions when the commit message is nonempty. */
function updateCommitButtons() {
  const valid = Boolean(commitMessage?.value.trim());

  if (commitStaged) commitStaged.disabled = !valid;
  if (commitAll) commitAll.disabled = !valid;
}

/**
 * Creates a commit through the Rust backend using the current dialog message.
 *
 * @param commitAllChanges - Whether Rust should stage all changes before committing.
 *
 * @remarks
 * Disables dialog controls during the request, refreshes the repository after success, and reports failures in the status display. Errors are caught rather than propagated.
 */
async function performCommit(commitAllChanges: boolean) {
  if (!currentRepoPath || !commitMessage || !commitDialog) return;

  const message = commitMessage.value.trim();
  if (!message) return;

  if (commitStaged) commitStaged.disabled = true;
  if (commitAll) commitAll.disabled = true;
  if (cancelCommit) cancelCommit.disabled = true;

  try {
    const commitId = await invoke<string>("commit_changes", {
      repoPath: currentRepoPath,
      message,
      commitAll: commitAllChanges,
    });

    console.log("Created commit:", commitId);

    await loadRepository(currentRepoPath);
    commitDialog.close();
  } catch (error) {
    console.error("Commit failed:", error);
    status.textContent = `Commit failed: ${error}`;
  } finally {
    if (cancelCommit) cancelCommit.disabled = false;
    updateCommitButtons();
  }
}

/**
 * Loads and displays local Git branches with switching controls.
 *
 * @param repoPath - Repository whose local branches should be listed.
 *
 * @remarks
 * Marks the current branch and adds Switch buttons to other branches. Errors are displayed in the branch list.
 */
async function loadLocalBranches(repoPath: string) {
  const branchList = document.querySelector<HTMLDivElement>("#branch-list");
  if (!branchList) return;

  branchList.textContent = "Loading branches...";

  try {
    const branches = await invoke<BranchInfo[]>("get_local_branches", {
      repoPath,
    });

    branchList.replaceChildren();

    for (const branch of branches) {
      const row = document.createElement("div");
      row.className = "branch-row";

      if (branch.is_current) {
        row.classList.add("current");
      }

      const name = document.createElement("span");
      name.textContent = branch.name;

      const hash = document.createElement("span");
      hash.className = "branch-hash";
      hash.textContent = branch.commit_hash?.substring(0, 7) ?? "—";

      row.appendChild(name);
      row.appendChild(hash);

      if (branch.is_current) {
        const badge = document.createElement("span");
        badge.className = "branch-current";
        badge.textContent = "Current";
        row.appendChild(badge);
      }

      if (!branch.is_current) {
        const switchButton = document.createElement("button");

        switchButton.className = "button branch-switch-button";
        switchButton.textContent = "Switch";

        switchButton.addEventListener("click", async () => {
          switchButton.disabled = true;
          switchButton.textContent = "Switching...";

          await switchBranch(repoPath, branch.name);

          switchButton.disabled = false;
          switchButton.textContent = "Switch";
        });

        row.appendChild(switchButton);
      }

      branchList.appendChild(row);
    }

    if (branches.length === 0) {
      branchList.textContent = "No local branches found.";
    }
  } catch (error) {
    console.error("Failed to load branches:", error);
    branchList.textContent = `Unable to load branches: ${error}`;
  }
}

/**
 * Requests a local branch checkout and refreshes the repository on success.
 *
 * @param repoPath - Repository containing the target branch.
 * @param branchName - Branch to check out.
 *
 * @remarks
 * Backend errors are caught and shown in an alert.
 */
async function switchBranch(
  repoPath: string,
  branchName: string,
): Promise<void> {
  try {
    await invoke("switch_branch", {
      repoPath,
      branchName,
    });
    await loadRepository(repoPath);
  } catch (error) {
    window.alert(String(error));
  }
}

/**
 * Populates merge options from local branches and identifies the current branch.
 *
 * @param repoPath - Repository from which to load branch names.
 *
 * @remarks
 * Excludes the current branch from the selectable options.
 *
 * @returns Name of the checked-out branch.
 *
 * @throws Throws if no current branch or alternative merge branch is available, or when the backend request fails.
 */
async function populateMergeDialog(repoPath: string) {
  const branches = await invoke<BranchInfo[]>("get_local_branches", {
    repoPath,
  });

  const current = branches.find((branch) => branch.is_current);

  const select = document.querySelector<HTMLSelectElement>(
    "#merge-other-branch",
  );

  if (!current || !select) {
    throw new Error("No current local branch was found.");
  }

  select.replaceChildren();

  for (const branch of branches) {
    if (branch.is_current) continue;

    const option = document.createElement("option");
    option.value = branch.name;
    option.textContent = branch.name;

    select.appendChild(option);
  }

  if (select.options.length === 0) {
    throw new Error("Create another local branch before merging.");
  }

  return current.name;
}

/**
 * Determines source and target branches from the selected merge direction.
 *
 * @returns Object containing the selected `source` and `target` branch names.
 */
function getMergeDirection() {
  const selected = document.querySelector<HTMLInputElement>(
    'input[name="merge-direction"]:checked',
  );

  const otherBranch = otherBranchSelect?.value ?? "";

  if (selected?.value === "into-other") {
    return {
      source: mergeCurrentBranch,
      target: otherBranch,
    };
  }

  return {
    source: otherBranch,
    target: mergeCurrentBranch,
  };
}

/** Updates the merge explanation and button label to reflect the selected direction. */
function updateMergePreview() {
  const { source, target } = getMergeDirection();

  const title = document.querySelector<HTMLElement>("#merge-preview-title");

  const description = document.querySelector<HTMLElement>(
    "#merge-preview-description",
  );

  const confirmButton =
    document.querySelector<HTMLButtonElement>("#confirm-merge");

  if (!title || !description || !confirmButton) return;

  title.textContent = `Merge ${source} into ${target}`;

  description.textContent =
    `${target} will receive the changes from ${source}. ` +
    `Clairvoyance will check out ${target} if necessary.`;

  confirmButton.textContent = `Merge into ${target}`;
}

// -- Repository Information & History --

/** Returns the palette color for a commit graph lane. */
function getGraphColor(lane: number): string {
  return graphColors[lane % graphColors.length];
}

/**
 * Assigns horizontal lanes and vertical rows to commits in the history graph.
 *
 * @param commits - Commits in the display order supplied by the backend.
 *
 * @remarks
 * Maintains an array of active lanes containing the parent hash each lane expects next. Reuses available lanes and assigns new lanes to additional merge parents. The first parent continues in the current lane when that parent is not already represented.
 *
 * @returns Commit records annotated with row and lane positions.
 */
function calculateGraphLanes(commits: CommitInfo[]): GraphCommit[] {
  const activeLanes: (string | null)[] = [];
  const graphCommits: GraphCommit[] = [];

  function findAvailableLane(): number {
    const available = activeLanes.indexOf(null);

    if (available !== -1) {
      return available;
    }

    activeLanes.push(null);
    return activeLanes.length - 1;
  }

  commits.forEach((commit, row) => {
    let lane = activeLanes.indexOf(commit.hash);

    if (lane === -1) {
      lane = findAvailableLane();
    }

    graphCommits.push({
      commit,
      row,
      lane,
    });

    activeLanes[lane] = null;

    const firstParent = commit.parents[0];

    if (firstParent && !activeLanes.includes(firstParent)) {
      activeLanes[lane] = firstParent;
    }

    for (const parent of commit.parents.slice(1)) {
      if (activeLanes.includes(parent)) {
        continue;
      }

        // Additional merge parents need their own lane until their commits are encountered.
      const parentLane = findAvailableLane();
      activeLanes[parentLane] = parent;
    }
  });

  return graphCommits;
}

/**
 * Builds graph edges between displayed commits and their parents.
 *
 * @param graphCommits - Commits with calculated graph positions.
 *
 * @remarks
 * Indexes commits by hash, then emits a connection for each parent present in the displayed history. Edges to parents outside the limited history are omitted.
 *
 * @returns Connections describing source and destination rows and lanes.
 */
function calculateGraphConnections(
  graphCommits: GraphCommit[],
): GraphConnection[] {
  const connections: GraphConnection[] = [];

    // Hash lookup avoids scanning every commit for each parent relationship.
  const commitPositions = new Map<string, GraphCommit>();

  for (const graphCommit of graphCommits) {
    commitPositions.set(graphCommit.commit.hash, graphCommit);
  }

  for (const graphCommit of graphCommits) {
    for (const parentHash of graphCommit.commit.parents) {
      const parent = commitPositions.get(parentHash);

      if (!parent) continue;

      connections.push({
        fromRow: graphCommit.row,
        fromLane: graphCommit.lane,
        toRow: parent.row,
        toLane: parent.lane,
      });
    }
  }

  return connections;
}

/**
 * Converts graph lanes and table row positions to SVG coordinates.
 *
 * @param graphCommits - Commits with assigned rows and lanes.
 * @param tableBody - Table body containing the commit rows.
 * @param container - Scrollable table container defining the coordinate origin.
 *
 * @remarks
 * Uses measured DOM rectangles, container scroll offsets, fixed lane spacing, and each row center to align graph lines with table content.
 *
 * @returns Screen-layout-based points for each displayed commit.
 *
 * @throws Throws if a commit row lacks its expected graph cell.
 */
function calculateGraphPositions(
  graphCommits: GraphCommit[],
  tableBody: HTMLTableSectionElement,
  container: HTMLElement,
): GraphPoint[] {
  const rows = Array.from(
    tableBody.querySelectorAll<HTMLTableRowElement>("tr.commit-history-row"),
  );
  // SVG coordinates must account for both rendered table geometry and scrolling.
  const containerRect = container.getBoundingClientRect();

  const laneSpacing = 24;
  const laneOffset = 20;

  return graphCommits.map((graphCommit) => {
    const row = rows[graphCommit.row];
    const cell = row.querySelector<HTMLElement>(".commit-graph-cell");

    if (!cell) {
      throw new Error("Graph cell not found.");
    }

    const rowRect = row.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();

    return {
      x:
        cellRect.left -
        containerRect.left +
        container.scrollLeft +
        laneOffset +
        graphCommit.lane * laneSpacing,

      y:
        rowRect.top -
        containerRect.top +
        container.scrollTop +
        rowRect.height / 2,
    };
  });
}

/** Creates an SVG path between two graph coordinates. */
function createConnectionPath(start: GraphPoint, end: GraphPoint): string {
  if (start.x === end.x) {
    return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  }

  const distance = end.y - start.y;

  const controlY1 = start.y + distance * 0.4;
  const controlY2 = end.y - distance * 0.4;

  return `
        M ${start.x} ${start.y}
        C ${start.x} ${controlY1},
          ${end.x} ${controlY2},
          ${end.x} ${end.y}
    `;
}

/**
 * Draws the repository commit graph as an SVG overlay on the history table.
 *
 * @param graphCommits - Displayed commits with lane assignments.
 * @param connections - Parent relationships to draw.
 * @param tableBody - History table body used for row alignment.
 * @param container - Scrollable container that hosts the SVG.
 *
 * @remarks
 * Replaces any previous graph overlay, measures commit row positions, and draws color-coded connections and nodes. An SVG mask hides graph paths behind an expanded commit-details row so the overlay does not cross the details content.
 */
function renderCommitGraph(
  graphCommits: GraphCommit[],
  connections: GraphConnection[],
  tableBody: HTMLTableSectionElement,
  container: HTMLElement,
) {
  container.querySelector(".commit-graph-overlay")?.remove();

  const points = calculateGraphPositions(graphCommits, tableBody, container);

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");

  svg.classList.add("commit-graph-overlay");
  svg.setAttribute("width", String(container.scrollWidth));
  svg.setAttribute("height", String(container.scrollHeight));

  // Mask the open details row so graph lines do not cover its contents.
  const mask = document.createElementNS(svgNS, "mask");
  mask.setAttribute("id", "commit-graph-mask");
  mask.setAttribute("maskUnits", "userSpaceOnUse");

  const visibleArea = document.createElementNS(svgNS, "rect");
  visibleArea.setAttribute("width", String(container.scrollWidth));
  visibleArea.setAttribute("height", String(container.scrollHeight));
  visibleArea.setAttribute("fill", "white");

  mask.appendChild(visibleArea);

  const detailsRow = tableBody.querySelector<HTMLElement>(
    ".commit-details-row",
  );
  if (detailsRow) {
    const containerRect = container.getBoundingClientRect();
    const detailsRect = detailsRow.getBoundingClientRect();

    const hiddenArea = document.createElementNS(svgNS, "rect");

    hiddenArea.setAttribute("x", "0");
    hiddenArea.setAttribute(
      "y",
      String(detailsRect.top - containerRect.top + container.scrollTop),
    );
    hiddenArea.setAttribute("width", String(container.scrollWidth));
    hiddenArea.setAttribute("height", String(detailsRect.height));
    hiddenArea.setAttribute("fill", "black");

    mask.appendChild(hiddenArea);
  }
  const graphGroup = document.createElementNS(svgNS, "g");
  graphGroup.setAttribute("mask", "url(#commit-graph-mask)");

  svg.appendChild(mask);
  for (const connection of connections) {
    const start = points[connection.fromRow];
    const end = points[connection.toRow];

    const path = document.createElementNS(svgNS, "path");

    path.setAttribute("d", createConnectionPath(start, end));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", getGraphColor(connection.fromLane));
    path.setAttribute("stroke-width", "2");

    graphGroup.appendChild(path);
  }
  for (const graphCommit of graphCommits) {
    const point = points[graphCommit.row];

    const circle = document.createElementNS(svgNS, "circle");

    circle.setAttribute("cx", String(point.x));
    circle.setAttribute("cy", String(point.y));
    circle.setAttribute("r", "5");
    circle.setAttribute("fill", getGraphColor(graphCommit.lane));

    graphGroup.appendChild(circle);
  }
  svg.appendChild(graphGroup);
  container.appendChild(svg);
}

/** Redraws the commit graph when its table is visible and measurable. */
function updateCommitGraph() {
  const tableBody = document.querySelector<HTMLTableSectionElement>(
    "#commit-history-body",
  );

  const container = document.querySelector<HTMLElement>(".table-container");

  if (!tableBody || !container) return;

  if (container.getClientRects().length === 0) return;

  renderCommitGraph(
    currentGraphCommits,
    currentGraphConnections,
    tableBody,
    container,
  );
}

/**
 * Loads commit history and constructs its interactive table and graph.
 *
 * @param repoPath - Repository whose commit history should be shown.
 *
 * @remarks
 * Requests commits, computes lanes and parent connections, creates selectable rows, and expands a details row for the selected commit. The graph is rerendered as selection changes; failures are displayed inside the table.
 */
async function loadCommitHistory(repoPath: string) {
  const tableBody = document.querySelector<HTMLTableSectionElement>(
    "#commit-history-body",
  );

  if (!tableBody) return;

  const details = document.querySelector<HTMLElement>("#commit-details");
  if (details) details.hidden = true;

  tableBody.textContent = "Loading commit history...";

  try {
    const commits = await invoke<CommitInfo[]>("get_commit_history", {
      repoPath,
    });

    currentGraphCommits = calculateGraphLanes(commits);
    currentGraphConnections = calculateGraphConnections(currentGraphCommits);

    const graphCommits = currentGraphCommits;
    const graphConnections = currentGraphConnections;

    const maxLane = Math.max(0, ...graphCommits.map((c) => c.lane));
    const graphWidth = 40 + maxLane * 24;

    tableBody.replaceChildren();

    commits.forEach((commit) => {
      const row = document.createElement("tr");
      row.className = "commit-history-row";

      row.addEventListener("click", () => {
        if (row.classList.contains("selected")) {
          closeCommitDetailsRow();
          row.classList.remove("selected");
          updateCommitGraph();
          return;
        }

        tableBody
          .querySelectorAll(".commit-history-row.selected")
          .forEach((element) => element.classList.remove("selected"));

        closeCommitDetailsRow();

        row.classList.add("selected");

        const detailsRow = document.createElement("tr");
        detailsRow.className = "commit-details-row";

        const detailsCell = document.createElement("td");
        detailsCell.colSpan = 5;

        const details = document.querySelector<HTMLElement>("#commit-details");

        row.dataset.commitHash = commit.hash;

        if (details) {
          detailsCell.appendChild(details);
          detailsRow.appendChild(detailsCell);

          row.insertAdjacentElement("afterend", detailsRow);

          showCommitDetails(commit);

          void loadCommitFileChanges(repoPath, commit.hash);
        }

        updateCommitGraph();

        updateCommitGraph();
      });

      const graphCell = document.createElement("td");
      graphCell.className = "commit-graph-cell";
      graphCell.style.width = `${graphWidth}px`;
      graphCell.style.minWidth = `${graphWidth}px`;

      const message = document.createElement("td");
      message.textContent = commit.message;

      const hash = document.createElement("td");
      hash.textContent = commit.hash.substring(0, 7);
      hash.title = commit.hash;

      const author = document.createElement("td");
      author.textContent = commit.author;

      const date = document.createElement("td");
      date.textContent = new Date(commit.timestamp * 1000).toLocaleString();

      row.append(graphCell, message, hash, author, date);
      tableBody.appendChild(row);
    });

    if (commits.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");

      cell.colSpan = 5;
      cell.textContent = "No commits found.";

      row.appendChild(cell);
      tableBody.appendChild(row);
    }

    const container = document.querySelector<HTMLElement>(".table-container");
    if (container) {
      renderCommitGraph(graphCommits, graphConnections, tableBody, container);
    }
  } catch (error) {
    console.error("Failed to load commit history:", error);

    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 5;
    cell.textContent = `Unable to load commit history: ${error}`;

    row.appendChild(cell);
    tableBody.replaceChildren(row);
  }
  updateCommitGraph();
}

/** Fills the commit details panel with metadata and parent commit hashes. */
function showCommitDetails(commit: CommitInfo) {
  const details = document.querySelector<HTMLElement>("#commit-details");
  const message = document.querySelector<HTMLElement>("#detail-message");
  const hash = document.querySelector<HTMLElement>("#detail-hash");
  const author = document.querySelector<HTMLElement>("#detail-author");
  const date = document.querySelector<HTMLElement>("#detail-date");
  const parents = document.querySelector<HTMLElement>("#detail-parents");

  if (!details || !message || !hash || !author || !date || !parents) {
    return;
  }

  message.textContent = commit.message;
  hash.textContent = commit.hash;
  author.textContent = commit.author;

  date.textContent = new Date(commit.timestamp * 1000).toLocaleString();

  parents.replaceChildren();

  if (commit.parents.length === 0) {
    parents.textContent = "Initial commit";
  } else {
    for (const parent of commit.parents) {
      const label = document.createElement("code");
      label.className = "commit-parent";
      label.textContent = parent.substring(0, 7);
      label.title = parent;

      parents.appendChild(label);
    }
  }
  details.hidden = false;
}

/** Closes the expanded history details and restores its panel outside the table. */
function closeCommitDetailsRow() {
  const details = document.querySelector<HTMLElement>("#commit-details");
  const detailsRow = document.querySelector<HTMLElement>(".commit-details-row");
  const tableContainer =
    document.querySelector<HTMLElement>(".table-container");

  if (details && tableContainer) {
    details.hidden = true;
    tableContainer.after(details);
  }

  detailsRow?.remove();
}

/**
 * Loads the files changed by a selected commit and displays their diff statistics.
 *
 * @param repoPath - Repository containing the selected commit.
 * @param commitHash - Commit to inspect.
 *
 * @remarks
 * Checks the selected history row after awaiting Rust so a late response does not replace another commit’s details. Updates the graph after rendering.
 */
async function loadCommitFileChanges(repoPath: string, commitHash: string) {
  const container = document.querySelector<HTMLElement>("#commit-changes-list");

  if (!container) return;

  container.textContent = "Loading changed files...";

  try {
    const changes = await invoke<CommitFileChange[]>(
      "get_commit_file_changes",
      {
        repoPath,
        commitHash,
      },
    );

    const selected = document.querySelector<HTMLTableRowElement>(
      ".commit-history-row.selected",
    );

    if (selected?.dataset.commitHash !== commitHash) return;

    container.replaceChildren();

    if (changes.length === 0) {
      container.textContent = "No file changes.";
      return;
    }

    for (const change of changes) {
      const fileRow = document.createElement("div");
      fileRow.className = "commit-change-row";

      const name = document.createElement("span");
      name.className = "commit-change-name";
      name.textContent = change.path;
      name.title = change.status;

      const status = document.createElement("span");
      status.className = "commit-change-status";
      status.textContent = change.status;

      const additions = document.createElement("span");
      additions.className = "commit-change-additions";
      additions.textContent =
        change.additions === null ? "—" : `+${change.additions}`;

      const deletions = document.createElement("span");
      deletions.className = "commit-change-deletions";
      deletions.textContent =
        change.deletions === null ? "—" : `-${change.deletions}`;

      fileRow.append(name, status, additions, deletions);
      container.appendChild(fileRow);
    }
    updateCommitGraph();
  } catch (error) {
    const selected = document.querySelector<HTMLTableRowElement>(
      ".commit-history-row.selected",
    );

    if (selected?.dataset.commitHash !== commitHash) return;

    container.textContent = `Failed to load changes: ${error}`;
  }
}

/** Returns a new date at local midnight on the Monday of the supplied week. */
function getWeekStart(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const day = (start.getDay() + 6) % 7;

  start.setDate(start.getDate() - day);
  return start;
}

/**
 * Groups commit activity into 12 consecutive Monday–Sunday weeks.
 *
 * @param commits - Commit records with Unix timestamps in seconds.
 *
 * @remarks
 * Builds fixed weekly buckets ending in the current week and counts matching commits using local dates.
 *
 * @returns Chart labels and commit counts for each week.
 */
function calculateWeeklyActivity(commits: ActivityCommit[]) {
  const labels: string[] = [];
  const counts: number[] = [];
  const weekStarts: number[] = [];

  // Fixed Monday-based buckets keep week labels consistent across chart refreshes.
  const currentWeek = getWeekStart(new Date());

  // Was going to do last 3 months, but 12 weeks seemed easier and keeps it consistent
  for (let i = 11; i >= 0; i--) {
    const week = new Date(currentWeek);
    week.setDate(week.getDate() - i * 7);

    const weekEnd = new Date(week);
    weekEnd.setDate(weekEnd.getDate() + 6);

    const startLabel = week.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });

    const endLabel = weekEnd.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });

    labels.push(`${startLabel} - ${endLabel}`);

    weekStarts.push(week.getTime());
    counts.push(0);
  }

  const currentWeekEnd = new Date(currentWeek);
  currentWeekEnd.setDate(currentWeekEnd.getDate() + 7);

  for (const commit of commits) {
    const date = new Date(commit.timestamp * 1000);
    const week = getWeekStart(date).getTime();

    const index = weekStarts.indexOf(week);

    if (index !== -1 && date.getTime() < currentWeekEnd.getTime()) {
      counts[index]++;
    }
  }

  return { labels, counts };
}

/**
 * Filters current activity records to the past 12 calendar-week buckets.
 *
 * @returns Activity commits between the earliest displayed Monday and now.
 */
function getActivityInRange(): ActivityCommit[] {
  const start = getWeekStart(new Date());
  start.setDate(start.getDate() - 11 * 7);

  const now = Date.now();

  return currentActivity.filter((commit) => {
    const timestamp = commit.timestamp * 1000;
    return timestamp >= start.getTime() && timestamp <= now;
  });
}

/** Updates total commits, active days, and unique contributor counts for recent activity. */
function renderActivityStatistics() {
  const commits = getActivityInRange();

  const activeDays = new Set(
    commits.map((commit) => new Date(commit.timestamp * 1000).toDateString()),
  );

  const contributors = new Set(commits.map((commit) => commit.author));

  const totalElement = document.querySelector<HTMLElement>(
    "#activity-total-commits",
  );

  const daysElement = document.querySelector<HTMLElement>(
    "#activity-active-days",
  );

  const contributorsElement = document.querySelector<HTMLElement>(
    "#activity-contributors",
  );

  if (totalElement) {
    totalElement.textContent = String(commits.length);
  }

  if (daysElement) {
    daysElement.textContent = String(activeDays.size);
  }

  if (contributorsElement) {
    contributorsElement.textContent = String(contributors.size);
  }
}

/**
 * Displays contributors ranked by commit count for the recent activity period.
 *
 * @remarks
 * Computes each contributor’s share relative to the most active contributor to size the horizontal bars.
 */
function renderContributorActivity() {
  const container = document.querySelector<HTMLElement>(
    "#activity-contributors-list",
  );

  if (!container) return;

  container.replaceChildren();

  const commits = getActivityInRange();
  const counts = new Map<string, number>();

  for (const commit of commits) {
    counts.set(commit.author, (counts.get(commit.author) ?? 0) + 1);
  }

  const contributors = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);

  if (contributors.length === 0) {
    container.textContent = "No contributor activity in this period.";
    return;
  }

  const maxCount = contributors[0][1];

  for (const [author, count] of contributors) {
    const row = document.createElement("div");
    row.className = "activity-contributor";

    const header = document.createElement("div");
    header.className = "activity-contributor-header";

    const name = document.createElement("span");
    name.textContent = author;

    const amount = document.createElement("span");
    amount.textContent = `${count} commits`;

    header.append(name, amount);

    const track = document.createElement("div");
    track.className = "activity-contributor-track";

    const bar = document.createElement("div");
    bar.className = "activity-contributor-bar";
    bar.style.width = `${(count / maxCount) * 100}%`;

    track.appendChild(bar);
    row.append(header, track);
    container.appendChild(row);
  }
}

/**
 * Renders the weekly activity chart and associated repository statistics.
 *
 * @remarks
 * Skips rendering when the canvas is unavailable or not laid out. Destroys the previous Chart.js instance before recreating it and updates contributor and aggregate statistics.
 */
function renderRepositoryActivity() {
  const canvas = document.querySelector<HTMLCanvasElement>("#activity-chart");

  const section = document.querySelector<HTMLElement>("#repository-activity");

  if (!canvas || !section) return;

  if (canvas.getClientRects().length === 0) return;

  const { labels, counts } = calculateWeeklyActivity(currentActivity);

  // Chart.js instances must be destroyed before reusing the canvas.
  activityChart?.destroy();

  activityChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Commits",
          data: counts,
          backgroundColor: "#61afef",
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#a0a6b0",
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "#a0a6b0",
            precision: 0,
          },
        },
      },
    },
  });

  renderActivityStatistics();
  renderContributorActivity();
}

/**
 * Requests activity records and refreshes repository activity visualizations.
 *
 * @param repoPath - Repository to analyze.
 *
 * @remarks
 * Increments a request identifier before starting; only the latest request may replace activity data. Clears any previous chart and catches backend errors to avoid displaying stale results.
 */
async function loadRepositoryActivity(repoPath: string) {
  // Incrementing the token invalidates any activity response from an earlier load.
  const requestId = ++activityRequestId;

  currentActivity = [];
  activityChart?.destroy();
  activityChart = null;

  try {
    const commits = await invoke<ActivityCommit[]>("get_repository_activity", {
      repoPath,
    });

    // Ignore a response if a newer repository activity request has started.
    if (requestId !== activityRequestId) return;

    currentActivity = commits;
    renderRepositoryActivity();
  } catch (error) {
    if (requestId !== activityRequestId) return;

    console.error("Failed to load repository activity:", error);
  }
}

// -- Git Guide --

/**
 * Builds the Git Guide category and topic navigation from guide data.
 *
 * @remarks
 * Creates expandable categories and clickable topic controls, then replaces their Lucide icon placeholders.
 */
function renderGitGuideTopics(): void {
  const container = document.querySelector<HTMLElement>("#git-guide-topics");

  if (!container) return;

  container.replaceChildren();

  for (const category of gitGuideCategories) {
    const details = document.createElement("details");
    details.className = "git-guide-category";

    const summary = document.createElement("summary");

    const categoryIcon = document.createElement("i");
    categoryIcon.setAttribute("data-lucide", category.icon);
    categoryIcon.className = "git-guide-icon";

    const categoryLabel = document.createElement("span");
    categoryLabel.textContent = category.title;

    summary.append(categoryIcon, categoryLabel);

    const topicList = document.createElement("div");
    topicList.className = "git-guide-category-topics";

    for (const topic of category.topics) {
      const explanation = gitExplanations[topic];

      const topicRow = document.createElement("button");
      topicRow.type = "button";
      topicRow.className = "git-guide-topic";
      topicRow.dataset.topic = topic;

      const topicIcon = document.createElement("i");
      topicIcon.setAttribute("data-lucide", "file-text");
      topicIcon.className = "git-guide-icon";

      const topicLabel = document.createElement("span");
      topicLabel.textContent = explanation.title;

      topicRow.append(topicIcon, topicLabel);

      topicRow.addEventListener("click", () => {
        showGitExplanation(topic);
      });

      topicList.appendChild(topicRow);
    }

    details.append(summary, topicList);
    container.appendChild(details);
  }

  createIcons({
    icons: {
      FolderGit2,
      FileDiff,
      GitCommitHorizontal,
      GitBranch,
      Globe,
      FileText,
    },
    root: container,
  });
}

/**
 * Displays the selected educational topic and its related Git visualization.
 *
 * @param topic - Key identifying an explanation in the Git Guide data.
 *
 * @remarks
 * Updates heading, summary, details, command, active topic styling, and the live Git areas diagram.
 */
function showGitExplanation(topic: keyof typeof gitExplanations): void {
  const explanation = gitExplanations[topic];

  currentGuideTopic = topic;

  const title = document.querySelector<HTMLElement>("#git-guide-title");
  const summary = document.querySelector<HTMLElement>("#git-guide-summary");
  const details = document.querySelector<HTMLElement>("#git-guide-details");
  const command = document.querySelector<HTMLElement>("#git-guide-command");
  const commandContainer = document.querySelector<HTMLElement>(
    "#git-guide-command-container",
  );

  if (!title || !summary || !details || !command || !commandContainer) return;

  title.textContent = explanation.title;
  summary.textContent = explanation.summary;
  details.textContent = explanation.details;

  command.textContent = explanation.command ?? "";
  commandContainer.hidden = !explanation.command;

  renderGitGuideVisual(explanation.visual);

  document
    .querySelectorAll<HTMLButtonElement>(".git-guide-topic")
    .forEach((button) => {
      button.classList.toggle("active", button.dataset.topic === topic);
    });
}

/**
 * Counts Git Guide working-tree changes, staged changes, and repository commits.
 *
 * @remarks
 * Recursively walks the currently loaded Explorer tree. A file can count in both working and staged areas; entries excluded from the visible tree are not counted.
 *
 * @returns Object containing working, staged, and commit counts; commit count is null when no summary is loaded.
 */
function getGitAreaCounts(): {
  working: number;
  staged: number;
  commits: number | null;
} {
  const counts = {
    working: 0,
    staged: 0,
    commits: currentGuideSummary?.total_commits ?? null,
  };

  // The guide can open before a repository has been selected.
  if (!currentGuideTree) {
    return counts;
  }

  function visit(entry: TreeEntry): void {
    if (entry.status?.unstaged) {
      counts.working += 1;
    }

    if (entry.status?.staged) {
      counts.staged += 1;
    }

    for (const child of entry.children) {
      visit(child);
    }
  }

  visit(currentGuideTree);
  return counts;
}

/** Creates a labeled card representing one of Git’s three areas. */
function createGitAreaCard(
  title: string,
  description: string,
  countText: string | null,
  iconName: string,
  active = false,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "git-area-card";

  if (active) {
    card.classList.add("active");
  }

  const header = document.createElement("div");
  header.className = "git-area-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "git-area-title-group";

  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", iconName);
  icon.className = "git-area-icon";

  const titleElement = document.createElement("span");
  titleElement.className = "git-area-title";
  titleElement.textContent = title;

  titleGroup.append(icon, titleElement);
  header.appendChild(titleGroup);

  if (countText) {
    const badge = document.createElement("span");
    badge.className = "git-area-count";
    badge.textContent = countText;
    header.appendChild(badge);
  }

  const descriptionElement = document.createElement("p");
  descriptionElement.className = "git-area-description";
  descriptionElement.textContent = description;

  card.append(header, descriptionElement);

  return card;
}

/** Creates an arrow label between Git area cards. */
function createGitAreaArrow(
  label: string,
  active = false,
  reverse = false,
): HTMLElement {
  const arrow = document.createElement("div");
  arrow.className = "git-area-arrow";
  arrow.textContent = label;

  if (active) {
    arrow.classList.add("active");
  }

  if (reverse) {
    arrow.classList.add("reverse");
  }

  return arrow;
}

/**
 * Displays the working directory, staging area, and repository as a live educational diagram.
 *
 * @param visual - Optional Git operation to highlight in the diagram.
 *
 * @remarks
 * Rebuilds the three area cards with counts from the current repository and highlights the selected operation. Omits the diagram when no visual is requested, and recreates its Lucide icons.
 */
function renderGitGuideVisual(
  visual: import("./gitGuide").GitGuideVisual | undefined,
): void {
  const container = document.querySelector<HTMLElement>(
    "#git-guide-visual-container",
  );

  if (!container) return;

  container.replaceChildren();

  if (!visual) {
    container.hidden = true;
    return;
  }

  const counts = getGitAreaCounts();
  const visualElement = document.createElement("div");
  visualElement.className = "git-areas-visual";

  const workingCard = createGitAreaCard(
    "Working Directory",
    "Files you are currently editing.",
    currentGuideTree ? `${counts.working} changed` : null,
    "file-pen-line",
    visual === "working-directory",
  );

  const firstArrow = createGitAreaArrow(
    visual === "unstaging" ? "git restore --staged" : "git add",
    visual === "staging-area" || visual === "unstaging",
    visual === "unstaging",
  );

  const stagingCard = createGitAreaCard(
    "Staging Area",
    "The snapshot prepared for your next commit.",
    currentGuideTree ? `${counts.staged} staged` : null,
    "layers",
    visual === "staging-area" || visual === "unstaging",
  );

  const secondArrow = createGitAreaArrow("git commit", visual === "committing");

  const repositoryCard = createGitAreaCard(
    "Repository",
    "Your saved project history.",
    counts.commits !== null ? `${counts.commits} commits` : null,
    "git-commit-horizontal",
    visual === "committing",
  );

  visualElement.append(
    workingCard,
    firstArrow,
    stagingCard,
    secondArrow,
    repositoryCard,
  );

  container.appendChild(visualElement);
  container.hidden = false;

  createIcons({
    icons: {
      FilePenLine,
      Layers,
      GitCommitHorizontal,
    },
    root: container,
  });
}

// -- Event Listeners --

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerURL;

renderRepositoryToolbarIcons();

if (repositoryIdentity) {
  createIcons({
    icons: { GitBranch },
    root: repositoryIdentity,
  });
}

if (gitGuideButton) {
  createIcons({
    icons: { BookOpen },
    root: gitGuideButton,
  });
}

if (gitGuidePanel) {
  createIcons({
    icons: {
      BookOpen,
      X,
      ListTree,
      Terminal,
    },
    root: gitGuidePanel,
  });
}

selectButton?.addEventListener("click", async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select a Git repository",
  });

  if (typeof selected !== "string") {
    return;
  }
  try {
    const isRepository = await invoke<boolean>("is_git_repository", {
      path: selected,
    });

    if (isRepository) {
      await loadRepository(selected);
    } else {
      showInitializeRepositoryDialog(selected, "existing");
    }
  } catch (error) {
    alert(`Could not open directory: ${error}`);
  }
});

refreshButton?.addEventListener("click", async () => {
  if (!currentRepoPath || !confirmDiscardEdits()) return;
  await loadRepository(currentRepoPath);
});

stageButton?.addEventListener("click", async () => {
  if (!currentRepoPath || !selectedFile || !stageButton) return;

  const repoPath = currentRepoPath;
  const filePath = selectedFile.path;
  const command = selectedFile.status?.unstaged
    ? "stage_file"
    : selectedFile.status?.staged
      ? "unstage_file"
      : null;

  if (!command) return;
  stageButton.disabled = true;

  try {
    await invoke(command, {
      repoPath,
      filePath,
    });
    await loadRepository(repoPath);
  } catch (error) {
    console.error(`Failed to ${command}:`, error);
    status.textContent = `Git operation failed: ${error}`;
    if (selectedFile) {
      updateStageButton(selectedFile);
    }
  }
});

commitButton?.addEventListener("click", () => {
  if (!commitDialog || !commitMessage) return;

  commitMessage.value = "";
  updateCommitButtons();

  commitDialog.showModal();
  commitMessage.focus();
});

cancelCommit?.addEventListener("click", () => {
  commitDialog?.close();
});

commitStaged?.addEventListener("click", () => {
  void performCommit(false);
});

commitMessage?.addEventListener("input", updateCommitButtons);

commitAll?.addEventListener("click", () => {
  void performCommit(true);
});

diffToggle?.addEventListener("change", async () => {
  if (!currentRepoPath || !selectedFile) {
    showingDiff = false;
    updateDiffToggle(null);
    return;
  }

  showingDiff = diffToggle.checked;

  const requestedPath = selectedFile.path;

  if (showingDiff) {
    try {
      const changes = await invoke<FileDiffLine[]>("get_file_diff", {
        repoPath: currentRepoPath,
        filePath: requestedPath,
      });

      if (!showingDiff || selectedFile?.path !== requestedPath) {
        return;
      }

      const pre = document.createElement("pre");
      pre.className = "file-text";

      for (const change of changes) {
        const line = document.createElement("div");
        line.className = `file-line diff-${change.line_type}`;

        const oldLineNumber = document.createElement("span");
        oldLineNumber.className = "line-number";
        oldLineNumber.textContent = change.old_line_number?.toString() ?? "";

        const newLineNumber = document.createElement("span");
        newLineNumber.className = "line-number";
        newLineNumber.textContent = change.new_line_number?.toString() ?? "";

        const content = document.createElement("span");
        content.className = "line-content";
        content.textContent = change.content;

        line.append(oldLineNumber, newLineNumber, content);
        pre.appendChild(line);
      }

      const fileContent =
        document.querySelector<HTMLDivElement>("#file-content");

      fileContent?.replaceChildren(pre);
    } catch (error) {
      console.error("Failed to load diff:", error);
      showingDiff = false;
      updateDiffToggle(selectedFile);
      status.textContent = `Failed to load changes: ${error}`;
    }
  } else {
    const fileElement = Array.from(
      treeContainer.querySelectorAll<HTMLElement>(".file"),
    ).find((element) => element.dataset.path === requestedPath);

    if (fileElement) {
      await openFile(selectedFile, fileElement);
    }
  }
});

overviewButton?.addEventListener("click", () => {
  showWorkspaceView("overview");

  updateCommitGraph();
  renderRepositoryActivity();
});

activitySection?.addEventListener("toggle", () => {
  if (activitySection.open) {
    renderRepositoryActivity();
  }
});

createBranchButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();

  if (!currentRepoPath) return;

  createBranchDialog?.showModal();
});

document
  .querySelector<HTMLButtonElement>("#cancel-create-branch")
  ?.addEventListener("click", () => {
    createBranchDialog?.close();
  });

createBranchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentRepoPath || !newBranchName) return;

  const repoPath = currentRepoPath;
  const branchName = newBranchName.value.trim();

  const submitButton = createBranchForm.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  if (submitButton) submitButton.disabled = true;
  try {
    await invoke("create_branch", {
      repoPath,
      branchName,
    });

    createBranchDialog?.close();
    createBranchForm.reset();

    await loadLocalBranches(repoPath);
  } catch (error) {
    window.alert(`Failed to create branch: ${error}`);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

document
  .querySelector<HTMLButtonElement>("#open-merge-dialog")
  ?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (!currentRepoPath || !mergeDialog) return;

    try {
      mergeCurrentBranch = await populateMergeDialog(currentRepoPath);

      updateMergePreview();
      mergeDialog.showModal();
    } catch (error) {
      window.alert(String(error));
    }
  });

otherBranchSelect?.addEventListener("change", updateMergePreview);

document
  .querySelectorAll<HTMLInputElement>('input[name="merge-direction"]')
  .forEach((radio) => {
    radio.addEventListener("change", updateMergePreview);
  });

mergeForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!currentRepoPath) return;

  const repoPath = currentRepoPath;
  const { source, target } = getMergeDirection();

  if (!source || !target || source === target) return;

  const confirmed = window.confirm(
    `Merge '${source}' into '${target}'?\n\n` +
      `'${target}' will receive the changes.\n` +
      `Your working directory must be clean.`,
  );

  if (!confirmed) return;

  const button = document.querySelector<HTMLButtonElement>("#confirm-merge");

  if (button) button.disabled = true;

  try {
    const result = await invoke<string>("merge_branches", {
      repoPath,
      sourceBranch: source,
      targetBranch: target,
    });

    mergeDialog?.close();

    window.alert(result);
  } catch (error) {
    window.alert(`Merge failed: ${error}`);
  } finally {
    try {
      await loadRepository(repoPath);
    } catch (refreshError) {
      console.error("Failed to refresh repository after merge:", refreshError);
    }

    if (button) button.disabled = false;
  }
});

cancelMergeButton?.addEventListener("click", () => {
  mergeDialog?.close();
});

editFileButton?.addEventListener("click", () => {
  startFileEditing();
});

cancelEditButton?.addEventListener("click", async () => {
  if (!selectedFile) return;
  if (editedFileContent !== originalFileContent) {
    const confirmed = window.confirm("Discard your unsaved changes?");
    if (!confirmed) return;
  }
  const selectedElement = document.querySelector<HTMLElement>(".file.selected");

  if (!selectedElement) return;

  isEditing = false;
  await openFile(selectedFile, selectedElement);
});

saveFileButton?.addEventListener("click", async () => {
  if (!currentRepoPath || !selectedFile || !isEditing) return;
  if (editedFileContent === originalFileContent) return;

  const repoPath = currentRepoPath;
  const filePath = selectedFile.path;
  const contents = editedFileContent;

  saveFileButton.disabled = true;
  saveFileButton.textContent = "Saving...";

  try {
    await invoke("save_file", {
      repoPath,
      filePath,
      contents,
    });

    originalFileContent = contents;
    editedFileContent = contents;
    isEditing = false;

    await loadRepository(repoPath);
  } catch (error) {
    console.error("Failed to save file:", error);
    window.alert(`Failed to save file: ${error}`);
  } finally {
    saveFileButton.textContent = "Save";
    updateEditingButtons();
  }
});

markdownToggle?.addEventListener("change", () => {
  if (!selectedFile || isEditing || showingDiff) return;

  showingMarkdownSource = markdownToggle.checked;

  renderCurrentMarkdownView();
});

hiddenFilesToggle?.addEventListener("change", () => {
  showHiddenFiles = hiddenFilesToggle.checked;

  if (currentRepoPath) {
    void loadRepository(currentRepoPath);
  }
});

document.addEventListener("click", (event) => {
  if (!explorerContextMenu?.contains(event.target as Node)) {
    hideExplorerContextMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideExplorerContextMenu();
  }
});

window.addEventListener("blur", hideExplorerContextMenu);

explorerContextMenu?.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-action]",
  );

  if (!button || !contextMenuEntry) return;

  const entry = contextMenuEntry;
  const action = button.dataset.action;

  hideExplorerContextMenu();

  switch (action) {
    case "new-file":
      void createExplorerEntry(entry, false);
      break;

    case "new-folder":
      void createExplorerEntry(entry, true);
      break;

    case "rename":
      if (!contextMenuIsRoot) {
        void renameExplorerEntry(entry);
      }
      break;

    case "move":
      if (!contextMenuIsRoot) {
        moveExplorerEntry(entry);
      }
      break;

    case "delete":
      if (!contextMenuIsRoot) {
        showDeleteConfirmation(entry);
      }
      break;
  }
});

cancelDeleteButton?.addEventListener("click", () => {
  deleteEntryDialog?.close();
});

confirmDeleteButton?.addEventListener("click", () => {
  if (!pendingDeleteEntry) return;

  const entry = pendingDeleteEntry;
  pendingDeleteEntry = null;

  deleteEntryDialog?.close();

  void deleteExplorerEntry(entry);
});

deleteEntryDialog?.addEventListener("close", () => {
  pendingDeleteEntry = null;
});

cancelInitButton?.addEventListener("click", () => {
  initRepositoryDialog?.close();
});

confirmInitButton?.addEventListener("click", async () => {
  if (
    !initRepositoryPath ||
    !initRepositoryName ||
    !initRepositoryBranch ||
    !confirmInitButton
  ) {
    return;
  }

  const parentPath = initRepositoryPath.value;
  const initialBranch = initRepositoryBranch.value.trim();

  const newName =
    repositoryInitMode === "new" ? initRepositoryName.value.trim() : null;

  if (!initialBranch || (repositoryInitMode === "new" && !newName)) {
    alert("Please complete the required fields.");
    return;
  }

  confirmInitButton.disabled = true;

  try {
    const repositoryPath = await invoke<string>("initialize_repository", {
      parentPath,
      newName,
      initialBranch,
    });

    initRepositoryDialog?.close();

    await loadRepository(repositoryPath);
  } catch (error) {
    alert(`Could not initialize repository: ${error}`);
  } finally {
    confirmInitButton.disabled = false;
  }
});

createRepositoryButton?.addEventListener("click", async () => {
  const parentPath = await open({
    directory: true,
    multiple: false,
    title: "Choose a location for the new repository",
  });

  if (!parentPath) return;

  showInitializeRepositoryDialog(parentPath, "new");
});

gitGuideButton?.addEventListener("click", () => {
  if (!gitGuidePanel) return;

  gitGuidePanel.hidden = !gitGuidePanel.hidden;
});

gitGuideClose?.addEventListener("click", () => {
  if (gitGuidePanel) {
    gitGuidePanel.hidden = true;
  }
});

renderGitGuideTopics();

showGitExplanation("welcome");

if (gitGuidePanel) {
  gitGuidePanel.hidden = false;
}
