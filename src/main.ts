import { invoke } from "@tauri-apps/api/core";
import "./styles.css";
import appHTML from "./app.html?raw";
import { open } from "@tauri-apps/plugin-dialog";
// Switched from emojis to lucide, so that can be recolored or altered in the future
import { createIcons, Folder, File, Lock } from "lucide";

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
let selectedFile: TreeEntry | null = null;
let currentRepoPath: string | null = null;
let showingDiff = false;

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
  if (currentRepoPath) {
    await loadRepository(currentRepoPath);
  }
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

    diffToggleContainer.hidden = !hasChanges;
    diffToggle.checked = hasChanges && showingDiff;
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
function renderEntry(entry: TreeEntry, isRoot = false): HTMLElement {
  if (entry.is_dir) {
    const details = document.createElement("details");
    details.className = "directory";
    details.open = isRoot && !entry.unreadable;

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
      children.appendChild(renderEntry(child));
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

// Loads the selected repository into the interface
async function loadRepository(path: string) {
  status.textContent = "Refreshing repository…";
  status.classList.remove("success");
  const summary = document.querySelector<HTMLDivElement>("#repo-status-summary");
  summary?.replaceChildren();
  try {
    const root = await invoke<TreeEntry>("get_repository_tree", { path });
    const selectedPath = selectedFile?.path;

    repoName.textContent = root.name || "Repository";
    currentRepoPath = path;

    if (commitButton) {
      commitButton.disabled = true;
    }

    treeContainer.replaceChildren(renderEntry(root, true));
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

  } catch (error) {
    status.textContent = "Failed to load repository";
    console.error("Failed to load repository:", error);
    if (refreshButton && !currentRepoPath) {
      refreshButton.disabled = true;
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

  document.querySelectorAll(".file.selected").forEach((file) => {
    file.classList.remove("selected");
  });

  element.classList.add("selected");

  selectedFile = entry;
  showingDiff = false;
  updateDiffToggle(entry);
  updateStageButton(entry);

  fileName.textContent = entry.name;
  filePath.textContent = entry.path;
  fileContent.textContent = "Loading file...";

  try {
    const contents = await invoke<string>("read_file", {
      repoPath: currentRepoPath,
      filePath: entry.path,
    });

    const diff = await invoke<FileDiffLine[]>("get_file_diff", {
      repoPath: currentRepoPath,
      filePath: entry.path,
    });

    console.table(diff);

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