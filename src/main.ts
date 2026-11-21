import { invoke } from "@tauri-apps/api/core";
import "./styles.css";
import appHTML from "./app.html?raw";
import { open } from "@tauri-apps/plugin-dialog";
import { createIcons, Folder, File, Lock } from "lucide";
import Chart from "chart.js/auto";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { renderAsync } from "docx-preview";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerURL;

interface GitFileStatus {
  staged: string | null;
  unstaged: string | null;
}

interface TreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  unreadable: boolean;
  status: GitFileStatus | null;
  children: TreeEntry[];
}

interface FileDiffLine {
  old_line_number: number | null;
  new_line_number: number | null;
  line_type: "added" | "removed" | "context";
  content: string;
}

interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
  parents: string[];
}

interface RepositorySummary {
  current_branch: string | null;
  changed_files: number;
  total_commits: number;
  branch_count: number;
  contributor_count: number;
  latest_commit: string | null;
}

interface BranchInfo {
  name: string;
  is_current: boolean;
  commit_hash: string | null;
}

interface GraphCommit {
  commit: CommitInfo;
  row: number;
  lane: number;
}

interface GraphConnection {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
}

interface GraphPoint {
  x: number;
  y: number;
}

interface CommitFileChange {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

interface ActivityCommit {
  timestamp: number;
  author: string;
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Could not find the app container");
}

// Main HTML code for the interface
app.innerHTML = appHTML;

// Variable declearation
const treeContainer = document.querySelector<HTMLDivElement>("#tree")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const repoName = document.querySelector<HTMLHeadingElement>("#repo-name")!;
const selectButton = document.querySelector<HTMLButtonElement>("#select-repo");
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh-repo");
const stageButton = document.querySelector<HTMLButtonElement>("#stage-button");
const commitButton = document.querySelector<HTMLButtonElement>("#commit-button");
const commitDialog = document.querySelector<HTMLDialogElement>("#commit-dialog");
const commitMessage = document.querySelector<HTMLTextAreaElement>("#commit-message");
const cancelCommit = document.querySelector<HTMLButtonElement>("#cancel-commit");
const commitStaged = document.querySelector<HTMLButtonElement>("#commit-staged");
const commitAll = document.querySelector<HTMLButtonElement>("#commit-all");
const diffToggle = document.querySelector<HTMLInputElement>("#diff-toggle");
const diffToggleContainer = document.querySelector<HTMLLabelElement>("#diff-toggle-container");
const overviewButton = document.querySelector<HTMLButtonElement>("#overview-button");
const activitySection = document.querySelector<HTMLDetailsElement>("#repository-activity");
const createBranchButton = document.querySelector<HTMLButtonElement>("#create-branch-button");
const createBranchDialog = document.querySelector<HTMLDialogElement>("#create-branch-dialog");
const createBranchForm = document.querySelector<HTMLFormElement>("#create-branch-form");
const newBranchName = document.querySelector<HTMLInputElement>("#new-branch-name");
const mergeDialog = document.querySelector<HTMLDialogElement>("#merge-branches-dialog");
const mergeForm = document.querySelector<HTMLFormElement>("#merge-branches-form");
const otherBranchSelect = document.querySelector<HTMLSelectElement>("#merge-other-branch");
const cancelMergeButton = document.querySelector<HTMLButtonElement>("#cancel-merge");
const editFileButton = document.querySelector<HTMLButtonElement>("#edit-file-button");
const cancelEditButton = document.querySelector<HTMLButtonElement>("#cancel-edit-button");
const saveFileButton = document.querySelector<HTMLButtonElement>("#save-file-button");
const markdownToggle = document.querySelector<HTMLInputElement>("#markdown-toggle");
const markdownToggleContainer = document.querySelector<HTMLLabelElement>("#markdown-toggle-container");
let mergeCurrentBranch = "";
let selectedFile: TreeEntry | null = null;
let currentRepoPath: string | null = null;
let showingDiff = false;
let currentGraphCommits: GraphCommit[] = [];
let currentGraphConnections: GraphConnection[] = [];
let activityChart: Chart | null = null;
let currentActivity: ActivityCommit[] = [];
let activityRequestId = 0;
let isEditing = false;
let originalFileContent = "";
let editedFileContent = "";
let currentImageURL: string | null = null;
let showingMarkdownSource = false;
type WorkspaceView = "file" | "overview";
const graphColors = [
  "#61afef",
  "#50b77a",
  "#d9a441",
  "#e3aa75",
  "#e06c75",
  "#c678dd",
];

function getGraphColor(lane: number): string {
  return graphColors[lane % graphColors.length];
}

// The button to open the system dialog and select a folder
selectButton?.addEventListener("click", async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select a Git repository",
  });

  if (typeof selected !== "string") {
    return;
  }
  await loadRepository(selected);
});

// The button to refresh the file tree, in case anything is moved or deleted
refreshButton?.addEventListener("click", async () => {
  if (!currentRepoPath || !confirmDiscardEdits()) return;
  await loadRepository(currentRepoPath);
});

// The button to stage and unstage changes in the repo
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

// These listeners are for the Commit pop-up window
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

// Toggles between showing and not showing the file changes
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

      // Ignore stale results if selection changes during loading.
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
        oldLineNumber.textContent =
          change.old_line_number?.toString() ?? "";

        const newLineNumber = document.createElement("span");
        newLineNumber.className = "line-number";
        newLineNumber.textContent =
          change.new_line_number?.toString() ?? "";

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
      treeContainer.querySelectorAll<HTMLElement>(".file")
    ).find(element => element.dataset.path === requestedPath);

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

document.querySelector<HTMLButtonElement>("#cancel-create-branch")?.addEventListener("click", () => {
  createBranchDialog?.close();
});

createBranchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentRepoPath || !newBranchName) return;

  const repoPath = currentRepoPath;
  const branchName = newBranchName.value.trim();

  const submitButton = createBranchForm.querySelector<HTMLButtonElement>(
    'button[type="submit"]'
  );
  if (submitButton) submitButton.disabled = true;
  try {
    await invoke("create_branch", {
      repoPath,
      branchName
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

document.querySelector<HTMLButtonElement>("#open-merge-dialog")?.addEventListener("click", async (event) => {
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

document.querySelectorAll<HTMLInputElement>('input[name="merge-direction"]').forEach(radio => {
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
    `Your working directory must be clean.`
  );

  if (!confirmed) return;

  const button = document.querySelector<HTMLButtonElement>(
    "#confirm-merge"
  );

  if (button) button.disabled = true;

  try {
    const result = await invoke<string>("merge_branches", {
      repoPath,
      sourceBranch: source,
      targetBranch: target
    });

    mergeDialog?.close();

    window.alert(result);
  } catch (error) {
    window.alert(`Merge failed: ${error}`);
  } finally {
    try {
      await loadRepository(repoPath);
    } catch (refreshError) {
      console.error(
        "Failed to refresh repository after merge:",
        refreshError
      );
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
    const confirmed = window.confirm(
      "Discard your unsaved changes?"
    );
    if (!confirmed) return;
  }
  const selectedElement = document.querySelector<HTMLElement>(
    ".file.selected"
  );

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
      contents
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

// Adds status totals to directories, makes it much easier to navigate
function countChangedFiles(entry: TreeEntry): number {
  if (!entry.is_dir) {
    return entry.status?.staged || entry.status?.unstaged ? 1 : 0;
  }

  return entry.children.reduce(
    (total, child) => total + countChangedFiles(child),
    0
  );
}

// Changes the stage button to unstage when appropriate
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

// Ensures commits are not made with empty messgaes
function updateCommitButtons() {
  const valid = Boolean(commitMessage?.value.trim());

  if (commitStaged) commitStaged.disabled = !valid;
  if (commitAll) commitAll.disabled = !valid;
}

function updateEditingButtons() {
  if (!editFileButton || !cancelEditButton || !saveFileButton) {
    return;
  }

  editFileButton.hidden = !selectedFile || isImageFile(selectedFile.name) || isPDFFile(selectedFile.name) || isDOCXFile(selectedFile.name) || isEditing || showingDiff;

  cancelEditButton.hidden = !isEditing;
  saveFileButton.hidden = !isEditing;

  saveFileButton.disabled =
    !isEditing || editedFileContent === originalFileContent;
}

// Actually commits file changes
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

// Handles the toggling of show changes
function updateDiffToggle(entry: TreeEntry | null) {
  if (!diffToggle || !diffToggleContainer) return;

  const hasChanges = Boolean(
    entry?.status?.staged || entry?.status?.unstaged
  );

  diffToggleContainer.hidden = !hasChanges || Boolean(entry && (isImageFile(entry.name) || isPDFFile(entry.name) || isDOCXFile(entry.name)));
  diffToggle.checked = hasChanges && showingDiff;
}

function updateMarkdownToggle(): void {
  if (!markdownToggle || !markdownToggleContainer) return;

  const isMarkdown = selectedFile !== null &&
    isMarkdownFile(selectedFile.name);

  markdownToggleContainer.hidden =
    !isMarkdown || isEditing || showingDiff;

  markdownToggle.checked = showingMarkdownSource;
}

// This function makes sure the same file is selected when updating or reloading the repo
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

// Recursively renders the file tree
function renderEntry(entry: TreeEntry, isRoot = false, expandedDirectories: Set<string> = new Set()): HTMLElement {
  if (entry.is_dir) {
    const details = document.createElement("details");
    details.className = "directory";
    details.dataset.path = entry.path;
    details.open = !entry.unreadable && (isRoot || expandedDirectories.has(entry.path));

    const summary = document.createElement("summary");
    const icon = document.createElement("i");

    icon.setAttribute(
      "data-lucide",
      entry.unreadable ? "lock" : "folder"
    );
    icon.className = "tree-icon";
    summary.appendChild(icon);
    const label = document.createTextNode(
      entry.unreadable
        ? ` ${entry.name} (Access denied)`
        : ` ${entry.name || "Repository root"}`
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
    return details;
  }

  const file = document.createElement("div");
  file.className = "file";
  file.dataset.path = entry.path;
  file.addEventListener("click", () => {
    void openFile(entry, file);
  });

  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", "file");
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

function getExpandedDirectories(): Set<string> {
  const expanded = new Set<string>();

  treeContainer
    .querySelectorAll<HTMLDetailsElement>("details.directory[open]")
    .forEach(details => {
      if (details.dataset.path !== undefined) {
        expanded.add(details.dataset.path);
      }
    });

  return expanded;
}

// Loads the selected repository into the interface
async function loadRepository(path: string) {
  status.textContent = "Refreshing repository…";
  status.classList.remove("success");
  const summary = document.querySelector<HTMLDivElement>("#repo-status-summary");
  summary?.replaceChildren();
  try {
    const root = await invoke<TreeEntry>("get_repository_tree", { path });

    await loadRepositorySummary(path);
    await loadCommitHistory(path);
    await loadLocalBranches(path);
    void loadRepositoryActivity(path); //Changed from await to void, large calculations can be time consuming

    const selectedPath = selectedFile?.path;

    repoName.textContent = root.name || "Repository";
    currentRepoPath = path;

    if (commitButton) {
      commitButton.disabled = true;
    }

    const expandedDirectories =
      currentRepoPath === path ? getExpandedDirectories() : new Set<string>();
    treeContainer.replaceChildren(renderEntry(root, true, expandedDirectories));
    renderStatusSummary(root);
    createIcons({
      icons: {
        Folder,
        File,
        Lock,
      },
    });

    if (selectedPath) {
      const updatedFile = findFileByPath(root, selectedPath);

      const fileElement = Array.from(
        treeContainer.querySelectorAll<HTMLElement>(".file")
      ).find(element => element.dataset.path === selectedPath);

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
      overviewButton.disabled = false
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

// Adds an indicator to the entry, if it's git status is not unmodified
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
    conflicted: "!"
  };

  const descriptions: Record<string, string> = {
    modified: "Modified",
    added: "Added",
    untracked: "Untracked",
    deleted: "Deleted",
    renamed: "Renamed",
    conflicted: "Conflicted"
  };

  indicator.textContent = labels[status] ?? "?";
  indicator.title = descriptions[status] ?? status;

  return indicator;
}

// Gets the git status of the files in the repository
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

// Creates a summary of git statuses, displayed at the top right
function renderStatusSummary(root: TreeEntry) {
  const summary = document.querySelector<HTMLDivElement>("#repo-status-summary");
  if (!summary) return;

  summary.replaceChildren();

  const counts = getStatusCounts(root);

  const labels: Record<string, string> = {
    modified: "M",
    added: "A",
    untracked: "U",
    deleted: "D",
    renamed: "R",
    conflicted: "!"
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
    "unstaged-conflicted"
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

// Opens and displays the selected file
async function openFile(entry: TreeEntry, element: HTMLElement) {
  if (!currentRepoPath) return;

  const fileName = document.querySelector<HTMLHeadingElement>("#file-name");
  const filePath = document.querySelector<HTMLParagraphElement>("#file-path");
  const fileContent = document.querySelector<HTMLDivElement>("#file-content");

  if (!fileName || !filePath || !fileContent) return;

  if (isEditing && editedFileContent !== originalFileContent) {
    const confirmed = window.confirm(
      "You have unsaved changes. Discard them and open another file?"
    );

    if (!confirmed) return;
  }

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
      const imageURL = await loadLocalImage(
        currentRepoPath,
        entry.path
      );

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
        filePath: entry.path
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
        filePath: entry.path
      });

      if (selectedFile !== entry) return;

      await renderDOCX(bytes, fileContent, () => selectedFile === entry);

      return;
    }
    const contents = await invoke<string>("read_file", {
      repoPath: currentRepoPath,
      filePath: entry.path,
    });

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

function renderPlainText(
  contents: string,
  container: HTMLElement
): void {
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

function renderCurrentMarkdownView(): void {
  if (!selectedFile || !isMarkdownFile(selectedFile.name)) {
    return;
  }

  const fileContent = document.querySelector<HTMLElement>(
    "#file-content"
  );

  if (!fileContent) return;

  if (showingMarkdownSource) {
    renderPlainText(originalFileContent, fileContent);
  } else {
    renderMarkdown(originalFileContent, fileContent);
  }

  updateMarkdownToggle();
}

function showWorkspaceView(view: WorkspaceView) {
  const fileView = document.querySelector<HTMLElement>("#file-view");
  const overview = document.querySelector<HTMLElement>("#repository-overview");

  if (!fileView || !overview) return;

  fileView.hidden = view !== "file";
  overview.hidden = view !== "overview";
}

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

      const parentLane = findAvailableLane();
      activeLanes[parentLane] = parent;
    }
  });

  return graphCommits;
}

function calculateGraphConnections(graphCommits: GraphCommit[]): GraphConnection[] {
  const connections: GraphConnection[] = [];

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

async function loadCommitHistory(repoPath: string) {
  const tableBody = document.querySelector<HTMLTableSectionElement>(
    "#commit-history-body"
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

    const maxLane = Math.max(0, ...graphCommits.map(c => c.lane));
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

        tableBody.querySelectorAll(".commit-history-row.selected")
          .forEach(element => element.classList.remove("selected"));

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
      date.textContent = new Date(
        commit.timestamp * 1000
      ).toLocaleString();

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
      renderCommitGraph(
        graphCommits,
        graphConnections,
        tableBody,
        container
      );
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

function updateCommitGraph() {
  const tableBody = document.querySelector<HTMLTableSectionElement>(
    "#commit-history-body"
  );

  const container = document.querySelector<HTMLElement>(
    ".table-container"
  );

  if (!tableBody || !container) return;

  if (container.getClientRects().length === 0) return;

  renderCommitGraph(
    currentGraphCommits,
    currentGraphConnections,
    tableBody,
    container
  );
}

async function loadRepositorySummary(repoPath: string) {
  const commits = document.querySelector<HTMLElement>("#summary-commits");
  const branches = document.querySelector<HTMLElement>("#summary-branches");
  const contributors = document.querySelector<HTMLElement>("#summary-contributors");
  const currentBranch = document.querySelector<HTMLElement>("#summary-current-branch");
  const changes = document.querySelector<HTMLElement>("#summary-changes");
  const latestCommit = document.querySelector<HTMLElement>("#summary-latest-commit");

  if (!commits || !branches || !contributors ||
    !currentBranch || !changes || !latestCommit) {
    return;
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
    changes.textContent = summary.changed_files === 0
      ? "Clean"
      : `${summary.changed_files} changed file${summary.changed_files === 1 ? "" : "s"}`;
    latestCommit.textContent = summary.latest_commit
      ? summary.latest_commit.substring(0, 7)
      : "No commits";
    if (summary.latest_commit) {
      latestCommit.title = summary.latest_commit;
    }
  } catch (error) {
    console.error("Failed to load repository summary:", error);
  }
}

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

function calculateGraphPositions(graphCommits: GraphCommit[], tableBody: HTMLTableSectionElement, container: HTMLElement): GraphPoint[] {
  const rows = Array.from(
    tableBody.querySelectorAll<HTMLTableRowElement>(
      "tr.commit-history-row"
    )
  );
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
      x: cellRect.left - containerRect.left
        + container.scrollLeft
        + laneOffset
        + graphCommit.lane * laneSpacing,

      y: rowRect.top - containerRect.top
        + container.scrollTop
        + rowRect.height / 2,
    };
  });
}

function createConnectionPath(
  start: GraphPoint,
  end: GraphPoint
): string {
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

function renderCommitGraph(graphCommits: GraphCommit[], connections: GraphConnection[], tableBody: HTMLTableSectionElement, container: HTMLElement) {
  container.querySelector(".commit-graph-overlay")?.remove();

  const points = calculateGraphPositions(
    graphCommits,
    tableBody,
    container
  );

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");

  svg.classList.add("commit-graph-overlay");
  svg.setAttribute("width", String(container.scrollWidth));
  svg.setAttribute("height", String(container.scrollHeight));

  const mask = document.createElementNS(svgNS, "mask");
  mask.setAttribute("id", "commit-graph-mask");
  mask.setAttribute("maskUnits", "userSpaceOnUse");

  const visibleArea = document.createElementNS(svgNS, "rect");
  visibleArea.setAttribute("width", String(container.scrollWidth));
  visibleArea.setAttribute("height", String(container.scrollHeight));
  visibleArea.setAttribute("fill", "white");

  mask.appendChild(visibleArea);

  const detailsRow = tableBody.querySelector<HTMLElement>(
    ".commit-details-row"
  );
  if (detailsRow) {
    const containerRect = container.getBoundingClientRect();
    const detailsRect = detailsRow.getBoundingClientRect();

    const hiddenArea = document.createElementNS(svgNS, "rect");

    hiddenArea.setAttribute("x", "0");
    hiddenArea.setAttribute(
      "y",
      String(detailsRect.top - containerRect.top + container.scrollTop)
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

  date.textContent = new Date(
    commit.timestamp * 1000
  ).toLocaleString();

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

function closeCommitDetailsRow() {
  const details = document.querySelector<HTMLElement>("#commit-details");
  const detailsRow = document.querySelector<HTMLElement>(".commit-details-row");
  const tableContainer = document.querySelector<HTMLElement>(".table-container");

  if (details && tableContainer) {
    details.hidden = true;
    tableContainer.after(details);
  }

  detailsRow?.remove();
}

async function loadCommitFileChanges(repoPath: string, commitHash: string) {
  const container = document.querySelector<HTMLElement>(
    "#commit-changes-list"
  );

  if (!container) return;

  container.textContent = "Loading changed files...";

  try {
    const changes = await invoke<CommitFileChange[]>(
      "get_commit_file_changes",
      {
        repoPath,
        commitHash
      }
    );

    const selected = document.querySelector<HTMLTableRowElement>(
      ".commit-history-row.selected"
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
      additions.textContent = change.additions === null
        ? "—"
        : `+${change.additions}`;

      const deletions = document.createElement("span");
      deletions.className = "commit-change-deletions";
      deletions.textContent = change.deletions === null
        ? "—"
        : `-${change.deletions}`;

      fileRow.append(name, status, additions, deletions);
      container.appendChild(fileRow);
    }
    updateCommitGraph();
  } catch (error) {
    const selected = document.querySelector<HTMLTableRowElement>(
      ".commit-history-row.selected"
    );

    if (selected?.dataset.commitHash !== commitHash) return;

    container.textContent = `Failed to load changes: ${error}`;
  }
}

async function switchBranch(repoPath: string, branchName: string): Promise<void> {
  try {
    await invoke("switch_branch", {
      repoPath,
      branchName
    });
    await loadRepository(repoPath);
  } catch (error) {
    window.alert(String(error));
  }
}

function getWeekStart(date: Date): Date {
  const start = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  );

  const day = (start.getDay() + 6) % 7;

  start.setDate(start.getDate() - day);
  return start;
}

function calculateWeeklyActivity(commits: ActivityCommit[]) {
  const labels: string[] = [];
  const counts: number[] = [];
  const weekStarts: number[] = [];

  const currentWeek = getWeekStart(new Date());

  // Was going to do last 3 months, but 12 weeks seemed easier and keeps it consistent
  for (let i = 11; i >= 0; i--) {
    const week = new Date(currentWeek);
    week.setDate(week.getDate() - i * 7);

    const weekEnd = new Date(week);
    weekEnd.setDate(weekEnd.getDate() + 6);

    const startLabel = week.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric"
    });

    const endLabel = weekEnd.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric"
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

function renderActivityStatistics() {
  const commits = getActivityInRange();

  const activeDays = new Set(
    commits.map(commit =>
      new Date(commit.timestamp * 1000).toDateString()
    )
  );

  const contributors = new Set(
    commits.map(commit => commit.author)
  );

  const totalElement = document.querySelector<HTMLElement>(
    "#activity-total-commits"
  );

  const daysElement = document.querySelector<HTMLElement>(
    "#activity-active-days"
  );

  const contributorsElement = document.querySelector<HTMLElement>(
    "#activity-contributors"
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

function renderContributorActivity() {
  const container = document.querySelector<HTMLElement>(
    "#activity-contributors-list"
  );

  if (!container) return;

  container.replaceChildren();

  const commits = getActivityInRange();
  const counts = new Map<string, number>();

  for (const commit of commits) {
    counts.set(
      commit.author,
      (counts.get(commit.author) ?? 0) + 1
    );
  }

  const contributors = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1]);

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

function renderRepositoryActivity() {
  const canvas = document.querySelector<HTMLCanvasElement>(
    "#activity-chart"
  );

  const section = document.querySelector<HTMLElement>(
    "#repository-activity"
  );

  if (!canvas || !section) return;

  if (canvas.getClientRects().length === 0) return;

  const { labels, counts } = calculateWeeklyActivity(currentActivity);

  activityChart?.destroy();

  activityChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Commits",
        data: counts,
        backgroundColor: "#61afef",
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#a0a6b0"
          }
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "#a0a6b0",
            precision: 0
          }
        }
      }
    }
  });

  renderActivityStatistics();
  renderContributorActivity();
}

function getActivityInRange(): ActivityCommit[] {
  const start = getWeekStart(new Date());
  start.setDate(start.getDate() - 11 * 7);

  const now = Date.now();

  return currentActivity.filter(commit => {
    const timestamp = commit.timestamp * 1000;
    return timestamp >= start.getTime() && timestamp <= now;
  });
}

async function loadRepositoryActivity(repoPath: string) {
  const requestId = ++activityRequestId;

  currentActivity = [];
  activityChart?.destroy();
  activityChart = null;

  try {
    const commits = await invoke<ActivityCommit[]>(
      "get_repository_activity",
      { repoPath }
    );

    if (requestId !== activityRequestId) return;

    currentActivity = commits;
    renderRepositoryActivity();
  } catch (error) {
    if (requestId !== activityRequestId) return;

    console.error("Failed to load repository activity:", error);
  }
}

async function populateMergeDialog(repoPath: string) {
  const branches = await invoke<BranchInfo[]>(
    "get_local_branches",
    { repoPath }
  );

  const current = branches.find(branch => branch.is_current);

  const select = document.querySelector<HTMLSelectElement>(
    "#merge-other-branch"
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

function getMergeDirection() {
  const selected = document.querySelector<HTMLInputElement>(
    'input[name="merge-direction"]:checked'
  );

  const otherBranch = otherBranchSelect?.value ?? "";

  if (selected?.value === "into-other") {
    return {
      source: mergeCurrentBranch,
      target: otherBranch
    };
  }

  return {
    source: otherBranch,
    target: mergeCurrentBranch
  };
}

function updateMergePreview() {
  const { source, target } = getMergeDirection();

  const title = document.querySelector<HTMLElement>(
    "#merge-preview-title"
  );

  const description = document.querySelector<HTMLElement>(
    "#merge-preview-description"
  );

  const confirmButton = document.querySelector<HTMLButtonElement>(
    "#confirm-merge"
  );

  if (!title || !description || !confirmButton) return;

  title.textContent = `Merge ${source} into ${target}`;

  description.textContent =
    `${target} will receive the changes from ${source}. ` +
    `Clairvoyance will check out ${target} if necessary.`;

  confirmButton.textContent = `Merge into ${target}`;
}

function startFileEditing() {
  if (!selectedFile || isEditing || showingDiff) return;

  const fileContent = document.querySelector<HTMLDivElement>(
    "#file-content"
  );

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

function confirmDiscardEdits(): boolean {
  if (!isEditing || editedFileContent === originalFileContent) {
    return true;
  }
  return window.confirm(
    "You have unsaved changes. Discard them?"
  );
}

function isMarkdownFile(filename: string): boolean {
  const extension = filename.toLowerCase();

  return extension.endsWith(".md") ||
    extension.endsWith(".markdown");
}

function isImageFile(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(filename);
}

function isPDFFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}

function isDOCXFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(".docx");
}

function renderMarkdown(contents: string, container: HTMLElement): void {
  const html = marked.parse(contents, {
    async: false,
    gfm: true,
    breaks: false
  });

  const sanitizedHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true }
  });

  const preview = document.createElement("div");
  preview.className = "markdown-preview";

  preview.innerHTML = sanitizedHTML;

  preview.querySelectorAll("img").forEach(image => {
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

  preview.querySelectorAll("a").forEach(link => {
    link.removeAttribute("href");
  });

  container.replaceChildren(preview);
}

async function loadLocalImage(repoPath: string, filePath: string): Promise<string> {
  const bytes = await invoke<number[]>("read_image", {
    repoPath,
    filePath
  });

  const extension = filePath.split(".").pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml"
  };

  const mimeType = mimeTypes[extension ?? ""];

  if (!mimeType) {
    throw new Error("Unsupported image format.");
  }

  const blob = new Blob(
    [new Uint8Array(bytes)],
    { type: mimeType }
  );

  return URL.createObjectURL(blob);
}

function renderImage(url: string, container: HTMLElement): void {
  const image = document.createElement("img");

  image.src = url;
  image.className = "file-image";
  image.alt = "Image preview";

  container.replaceChildren(image);
}

async function renderPDF(bytes: number[], container: HTMLElement): Promise<void> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(bytes)
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
      viewport
    }).promise;
  }
}

async function renderDOCX(bytes: number[], container: HTMLElement, isCurrent: () => boolean): Promise<void> {
  const viewer = document.createElement("div");
  viewer.className = "docx-viewer";

  await renderAsync(
    new Uint8Array(bytes),
    viewer,
    undefined,
    {
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      useBase64URL: true
    }
  );

  if (!isCurrent()) return;

  container.replaceChildren(viewer);
}