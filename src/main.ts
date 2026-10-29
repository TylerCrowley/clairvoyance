
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";
import { open } from "@tauri-apps/plugin-dialog";

interface TreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeEntry[];
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Could not find the app container");
}

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
          </div>
          <div id="tree" class="tree">
              <p class="muted">Open a repository to explore its files.</p>
          </div>
      </section>
  </main>
`;

const treeContainer = document.querySelector<HTMLDivElement>("#tree")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const repoName = document.querySelector<HTMLHeadingElement>("#repo-name")!;
const selectButton = document.querySelector<HTMLButtonElement>("#select-repo");
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh-repo");

let currentRepoPath: string | null = null;

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

  try {
    status.textContent = "Loading repository…";
    status.classList.remove("success");

    const root = await invoke<TreeEntry>("get_repository_tree", { path: selected, });

    repoName.textContent = root.name || "Repository";
    treeContainer.replaceChildren(renderEntry(root));
    status.textContent = "Repository loaded";
    status.classList.add("success");

    const repoPath = document.querySelector<HTMLSpanElement>("#repo-path");
    if (repoPath) {
      repoPath.textContent = selected;
      repoPath.title = selected;
    }

    status.textContent = "Repository loaded";
    status.classList.add("success");
  } catch (error) {
    status.textContent = "Unable to open repository";
    treeContainer.textContent = String(error);
    console.error("Failed to load repository:", error);

  }
});

refreshButton?.addEventListener("click", async () => {
  if (currentRepoPath) {
    await loadRepository(currentRepoPath);
  }
});

function renderEntry(entry: TreeEntry): HTMLElement {
  if (entry.is_dir) {
    const details = document.createElement("details");
    details.className = "directory";
    details.open = entry.path === "";

    const summary = document.createElement("summary");
    summary.textContent = `📁 ${entry.name || "Repository root"}`;
    summary.title = entry.path || ".";

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
  file.textContent = `📄 ${entry.name}`;
  file.title = entry.path;
  return file;
}

async function loadRepository(path: string) {
  status.textContent = "Refreshing repository…";
  status.classList.remove("success");

  try {
    const root = await invoke<TreeEntry>(
      "get_repository_tree",
      { path }
    );

    treeContainer.replaceChildren(renderEntry(root));


    repoName.textContent = root.name || "Repository";
    currentRepoPath = path;

    const repoPath =
      document.querySelector<HTMLSpanElement>("#repo-path");

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