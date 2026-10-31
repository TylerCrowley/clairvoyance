import { invoke } from "@tauri-apps/api/core";
import "./styles.css";
import { open } from "@tauri-apps/plugin-dialog";
// Switched from emojis to lucide, so that can be recolored or altered in the future
import { createIcons, Folder, File, Lock } from "lucide";

interface TreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  unreadable: boolean;
  status: string | null;
  children: TreeEntry[];
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Could not find the app container");
}

// Main HTML code for the interface
app.innerHTML = `
  <header class="topbar">
      <div>
          <p class="eyebrow">CLAIRVOYANCE</p>
          <h1>Repository Explorer</h1>
      </div>
      <div class="repo-controls">
          <button id="select-repo" class="button button-primary">
              <span>+</span>
              Open Repository
          </button>
          <button id="refresh-repo" class="button" disabled>
              Refresh
          </button>
          <span id="repo-path" class="repo-path">
              No repository selected
          </span>
      </div>
      <span id="status" class="status">No repository selected</span>
  </header>

  <main>
      <section class="panel">
          <div class="panel-heading">
              <div>
                  <h2 id="repo-name">No repository open</h2>
                  <p class="muted">Files and directories</p>
              </div>

              <div id="repo-status-summary"></div>
          </div>

          <div id="tree" class="tree">
              <p class="muted">Open a repository to explore its files.</p>
          </div>
      </section>
  </main>
`;

// Variable declearation
const treeContainer = document.querySelector<HTMLDivElement>("#tree")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const repoName = document.querySelector<HTMLHeadingElement>("#repo-name")!;
const selectButton = document.querySelector<HTMLButtonElement>("#select-repo");
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh-repo");

let currentRepoPath: string | null = null;

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

    const indicator = createStatusIndicator(entry.status);
    if (indicator) {
      summary.appendChild(indicator);
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

  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", "file");
  icon.className = "tree-icon";

  file.appendChild(icon);
  file.appendChild(document.createTextNode(` ${entry.name}`));
  const indicator = createStatusIndicator(entry.status);

  if (indicator) {
    file.appendChild(indicator);
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
    repoName.textContent = root.name || "Repository";
    currentRepoPath = path;

    treeContainer.replaceChildren(renderEntry(root, true));
    renderStatusSummary(root);
    createIcons({
      icons: {
        Folder,
        File,
        Lock,
      },
    });

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

  // Short version of the labels
  const labels: Record<string, string> = {
    modified: "M",
    added: "A",
    untracked: "U",
    deleted: "D",
    renamed: "R",
    conflicted: "!",
  };

  indicator.textContent = labels[status] ?? "?";
  // Long version of the labels
  const descriptions: Record<string, string> = {
    modified: "Modified",
    added: "Added",
    untracked: "Untracked",
    deleted: "Deleted",
    renamed: "Renamed",
    conflicted: "Conflicted"
  };
  indicator.title = descriptions[status] ?? status;

  return indicator;
}

// Gets the git status of the files in the repository
function getStatusCounts(root: TreeEntry): Record<string, number> {
  const counts: Record<string, number> = {};

  function visit(entry: TreeEntry) {
    if (entry.status) {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
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
    "modified",
    "added",
    "untracked",
    "deleted",
    "renamed",
    "conflicted"
  ];
  for (const status of order) {
    const count = counts[status];

    if (!count) continue;

    const item = document.createElement("span");
    item.className = `git-status git-status-${status}`;
    item.textContent = `${labels[status]} ${count}`;
    item.title = `${count} ${status} file${count === 1 ? "" : "s"}`;

    summary.appendChild(item);
  }
}