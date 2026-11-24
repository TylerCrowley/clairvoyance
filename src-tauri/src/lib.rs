// Rust libraries
use git2::{
    build::CheckoutBuilder,
    BranchType,
    DiffFormat,
    DiffOptions,
    Repository,
    RepositoryState,
    Sort,
    Status,
    StatusOptions,
    ErrorCode,
    IndexAddOption,
    Oid,
    Patch,
    ReferenceType,
    Branch,
    RepositoryInitOptions,
};
use serde::Serialize;
use std::collections::{ HashMap, HashSet };
use std::fs;
use std::path::{ Path, PathBuf };

#[derive(Serialize, Clone)]
// Moved Git status into it's own data type
struct GitFileStatus {
    staged: Option<String>,
    unstaged: Option<String>,
}

#[derive(Serialize)]
// Data structure for each entry in the file tree
struct TreeEntry {
    name: String,
    path: String,
    is_dir: bool,
    unreadable: bool,
    status: Option<GitFileStatus>,
    children: Vec<TreeEntry>,
}

#[derive(Serialize)]
// Used to track the changes made to a file, when displayed
struct FileDiffLine {
    old_line_number: Option<u32>,
    new_line_number: Option<u32>,
    line_type: String,
    content: String,
}

#[derive(Serialize)]
struct CommitInfo {
    hash: String,
    message: String,
    author: String,
    timestamp: i64,
    parents: Vec<String>,
}

#[derive(Serialize)]
struct RepositorySummary {
    current_branch: Option<String>,
    changed_files: usize,
    total_commits: usize,
    branch_count: usize,
    contributor_count: usize,
    latest_commit: Option<String>,
}

#[derive(Serialize)]
struct BranchInfo {
    name: String,
    is_current: bool,
    commit_hash: Option<String>,
}

#[derive(Serialize)]
struct CommitFileChange {
    path: String,
    status: String,
    additions: Option<usize>,
    deletions: Option<usize>,
}

#[derive(Serialize)]
struct ActivityCommit {
    timestamp: i64,
    author: String,
}

// Reads the directory and creates the file tree structure
fn build_tree(
    path: &Path,
    repo_root: &Path,
    statuses: &HashMap<String, GitFileStatus>,
    show_hidden: bool
) -> TreeEntry {
    let mut entries = Vec::new();

    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Repository root".to_string());

    let read_dir = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!("Could not read directory {}: {}", path.display(), error);

            return TreeEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: true,
                unreadable: true,
                status: None,
                children: entries,
            };
        }
    };

    for entry in read_dir {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!("Could not read directory entry: {}", error);
                continue;
            }
        };

        let name = entry.file_name().to_string_lossy().into_owned();

        if name == ".git" || (!show_hidden && name.starts_with('.')) {
            continue;
        }

        let entry_path = entry.path();

        let relative_path = entry_path
            .strip_prefix(repo_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let status = statuses.get(&relative_path).cloned();

        let metadata = match fs::symlink_metadata(&entry_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                eprintln!("Could not read metadata for {}: {}", entry_path.display(), error);
                continue;
            }
        };

        let is_dir = metadata.is_dir() && !metadata.file_type().is_symlink();

        let (children, unreadable) = if is_dir {
            let child_tree = build_tree(&entry_path, repo_root, statuses, show_hidden);
            let unreadable = child_tree.unreadable;

            (child_tree.children, unreadable)
        } else {
            (Vec::new(), false)
        };

        entries.push(TreeEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            unreadable,
            status,
            children,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    TreeEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir: true,
        unreadable: false,
        status: None,
        children: entries,
    }
}

#[tauri::command]
fn get_repository_tree(path: String, show_hidden: bool) -> Result<TreeEntry, String> {
    let repo = Repository::open(&path).map_err(|_|
        "The selected folder is not a valid Git repository.".to_string()
    )?;

    let root = repo.workdir().ok_or_else(|| "Empty repositories are not supported.".to_string())?;

    let statuses = get_repository_statuses(&repo)?;

    Ok(build_tree(root, root, &statuses, show_hidden))
}

// Creates a hash map of the statuses of each file in the repository, this seemed much faster than grabbing each one individually
fn get_repository_statuses(repo: &Repository) -> Result<HashMap<String, GitFileStatus>, String> {
    let mut options = StatusOptions::new();

    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .include_unmodified(false);

    let statuses = repo.statuses(Some(&mut options)).map_err(|error| error.to_string())?;

    let mut result = HashMap::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("Unknown").to_string();
        let status = entry.status();

        let staged = if status.contains(Status::CONFLICTED) {
            Some("conflicted".to_string())
        } else if status.contains(Status::INDEX_NEW) {
            Some("added".to_string())
        } else if status.contains(Status::INDEX_MODIFIED) {
            Some("modified".to_string())
        } else if status.contains(Status::INDEX_DELETED) {
            Some("deleted".to_string())
        } else if status.contains(Status::INDEX_RENAMED) {
            Some("renamed".to_string())
        } else if status.contains(Status::INDEX_TYPECHANGE) {
            Some("typechanged".to_string())
        } else {
            None
        };

        let unstaged = if status.contains(Status::CONFLICTED) {
            Some("conflicted".to_string())
        } else if status.contains(Status::WT_NEW) {
            Some("untracked".to_string())
        } else if status.contains(Status::WT_MODIFIED) {
            Some("modified".to_string())
        } else if status.contains(Status::WT_DELETED) {
            Some("deleted".to_string())
        } else if status.contains(Status::WT_RENAMED) {
            Some("renamed".to_string())
        } else if status.contains(Status::WT_TYPECHANGE) {
            Some("typechanged".to_string())
        } else {
            None
        };

        result.insert(path, GitFileStatus { staged, unstaged });
    }

    Ok(result)
}

#[tauri::command]
// Reads the file content
fn read_file(repo_path: String, file_path: String) -> Result<String, String> {
    let repo_root = fs::canonicalize(&repo_path).map_err(|error| error.to_string())?;

    let file = fs::canonicalize(&file_path).map_err(|error| error.to_string())?;

    if !file.starts_with(&repo_root) {
        return Err("File is outside the selected repository.".to_string());
    }

    if !file.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    let metadata = fs::metadata(&file).map_err(|error| error.to_string())?;

    if metadata.len() > 2 * 1024 * 1024 {
        return Err("File is too large to display (2 MB limit).".to_string());
    }

    let bytes = fs::read(&file).map_err(|e| format!("Failed to read file: {e}"))?;

    let contents = String::from_utf8(bytes).map_err(|_| "UNSUPPORTED_BINARY_FILE".to_string())?;

    Ok(contents)
}

#[tauri::command]
// Stages the changes in a file
fn stage_file(repo_path: String, file_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let repo_root = repo
        .workdir()
        .ok_or_else(|| "Cannot stage files in a bare repository.".to_string())?;

    let relative_path = Path::new(&file_path)
        .strip_prefix(repo_root)
        .map_err(|_| "File is outside the repository.".to_string())?;

    let mut index = repo.index().map_err(|error| error.to_string())?;

    index.add_path(relative_path).map_err(|error| format!("Could not stage file: {}", error))?;

    index.write().map_err(|error| format!("Could not save Git index: {}", error))?;

    Ok(())
}

#[tauri::command]
// Unstages changes in a file that have already been staged
fn unstage_file(repo_path: String, file_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let repo_root = repo.workdir().ok_or("Cannot unstage files in a bare repository.")?;

    let repo_root = fs::canonicalize(repo_root).map_err(|error| error.to_string())?;

    let file = fs::canonicalize(&file_path).map_err(|error| error.to_string())?;

    let relative_path = file
        .strip_prefix(&repo_root)
        .map_err(|_| "File is outside the repository.")?;

    if !file.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    let head = match repo.head() {
        Ok(head) => {
            let commit = head.peel_to_commit().map_err(|error| error.to_string())?;

            Some(commit.into_object())
        }
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            None
        }
        Err(error) => {
            return Err(error.to_string());
        }
    };

    repo
        .reset_default(head.as_ref(), [relative_path])
        .map_err(|error| format!("Could not unstage file: {}", error))?;

    Ok(())
}

#[tauri::command]
// Creates a git commit for the current changes, either all of them or just staged changes
fn commit_changes(repo_path: String, message: String, commit_all: bool) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let mut index = repo.index().map_err(|error| error.to_string())?;

    if commit_all {
        index.add_all(["*"], IndexAddOption::DEFAULT, None).map_err(|error| error.to_string())?;

        index.update_all(["*"], None).map_err(|error| error.to_string())?;

        index.write().map_err(|error| error.to_string())?;
    }

    let tree_oid = index.write_tree().map_err(|error| error.to_string())?;

    let tree = repo.find_tree(tree_oid).map_err(|error| error.to_string())?;

    let signature = repo.signature().map_err(|error| error.to_string())?;

    let parent = repo
        .head()
        .map_err(|error| error.to_string())?
        .peel_to_commit()
        .map_err(|error| error.to_string())?;

    let commit_oid = repo
        .commit(Some("HEAD"), &signature, &signature, &message, &tree, &[&parent])
        .map_err(|error| error.to_string())?;
    Ok(commit_oid.to_string())
}

#[tauri::command]
// Goes through each line of the file and tracks differences compared to the commited version
fn get_file_diff(repo_path: String, file_path: String) -> Result<Vec<FileDiffLine>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let repo_root = repo.workdir().ok_or("Repository has no working directory.")?;

    let repo_root = fs::canonicalize(repo_root).map_err(|error| error.to_string())?;

    let file = fs::canonicalize(&file_path).map_err(|error| error.to_string())?;

    let relative_path = file
        .strip_prefix(&repo_root)
        .map_err(|_| "File is outside the repository.")?;

    if !file.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    let head_tree = match repo.head() {
        Ok(head) => Some(head.peel_to_tree().map_err(|error| error.to_string())?),
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            None
        }
        Err(error) => {
            return Err(error.to_string());
        }
    };

    let mut options = DiffOptions::new();

    options
        .pathspec(relative_path)
        .show_untracked_content(true)
        .recurse_untracked_dirs(true)
        .context_lines(3);

    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut options))
        .map_err(|error| error.to_string())?;

    let mut lines = Vec::new();

    diff
        .print(DiffFormat::Patch, |_delta, _hunk, line| {
            let line_type = match line.origin() {
                '+' => "added",
                '-' => "removed",
                ' ' => "context",
                _ => {
                    return true;
                }
            };

            let content = String::from_utf8_lossy(line.content())
                .trim_end_matches(['\r', '\n'])
                .to_string();

            lines.push(FileDiffLine {
                old_line_number: line.old_lineno(),
                new_line_number: line.new_lineno(),
                line_type: line_type.to_string(),
                content,
            });

            true
        })
        .map_err(|error| error.to_string())?;

    Ok(lines)
}

#[tauri::command]
fn get_commit_history(repo_path: String) -> Result<Vec<CommitInfo>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let mut revwalk = repo.revwalk().map_err(|error| error.to_string())?;
    revwalk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|error| error.to_string())?;
    revwalk.push_glob("refs/heads/*").map_err(|error| error.to_string())?;
    revwalk.push_glob("refs/remotes/*").map_err(|error| error.to_string())?;

    let mut commits = Vec::new();
    for oid_result in revwalk.take(50) {
        let oid = oid_result.map_err(|error| error.to_string())?;
        let commit = repo.find_commit(oid).map_err(|error| error.to_string())?;

        let info = CommitInfo {
            hash: commit.id().to_string(),
            message: commit
                .summary()
                .map_err(|error| error.to_string())?
                .unwrap_or("")
                .to_string(),
            author: commit.author().name().unwrap_or("Unknown").to_string(),
            timestamp: commit.time().seconds(),
            parents: commit
                .parent_ids()
                .map(|id| id.to_string())
                .collect(),
        };

        commits.push(info);
    }

    Ok(commits)
}

#[tauri::command]
fn get_repository_summary(repo_path: String) -> Result<RepositorySummary, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let head_commit = match repo.head() {
        Ok(head) => Some(head.peel_to_commit().map_err(|error| error.to_string())?),
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            None
        }
        Err(error) => {
            return Err(error.to_string());
        }
    };

    let current_branch = match repo.head() {
        Ok(head) if head.is_branch() =>
            Some(
                head
                    .shorthand()
                    .map_err(|error| error.to_string())?
                    .to_string()
            ),
        Ok(_) => None, // Detached HEAD
        Err(error) if error.code() == ErrorCode::UnbornBranch => None,
        Err(error) => {
            return Err(error.to_string());
        }
    };

    let statuses = get_repository_statuses(&repo)?;

    let branches = repo.branches(Some(BranchType::Local)).map_err(|error| error.to_string())?;
    let branch_count = branches
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .len();

    let mut revwalk = repo.revwalk().map_err(|error| error.to_string())?;
    revwalk.push_head().map_err(|error| error.to_string())?;
    let mut total_commits = 0;
    let mut contributors = HashSet::new();
    if let Some(ref commit) = head_commit {
        let mut revwalk = repo.revwalk().map_err(|error| error.to_string())?;
        revwalk.push(commit.id()).map_err(|error| error.to_string())?;

        for oid_result in revwalk {
            let oid = oid_result.map_err(|error| error.to_string())?;
            let commit = repo.find_commit(oid).map_err(|error| error.to_string())?;
            total_commits += 1;
            let author = commit.author();
            if let Ok(email) = author.email() {
                contributors.insert(email.to_string());
            }
        }
    }
    let contributor_count = contributors.len();

    let latest_commit = match repo.head() {
        Ok(head) => {
            let commit = head.peel_to_commit().map_err(|error| error.to_string())?;

            Some(commit.id().to_string())
        }
        Err(error) if error.code() == ErrorCode::UnbornBranch => None,
        Err(error) => {
            return Err(error.to_string());
        }
    };

    let summary = RepositorySummary {
        current_branch: current_branch,
        changed_files: statuses.len(),
        total_commits: total_commits,
        branch_count: branch_count,
        contributor_count: contributor_count,
        latest_commit: latest_commit,
    };

    Ok(summary)
}

#[tauri::command]
fn get_local_branches(repo_path: String) -> Result<Vec<BranchInfo>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let mut branches = Vec::new();

    let iterator = repo.branches(Some(BranchType::Local)).map_err(|error| error.to_string())?;

    for branch_result in iterator {
        let (branch, _) = branch_result.map_err(|error| error.to_string())?;

        let name = branch
            .name()
            .map_err(|error| error.to_string())?
            .unwrap_or("Unknown")
            .to_string();

        let is_current = branch.is_head();

        let commit_hash = branch
            .get()
            .target()
            .map(|oid| oid.to_string());

        branches.push(BranchInfo {
            name,
            is_current,
            commit_hash,
        });
    }

    Ok(branches)
}

#[tauri::command]
fn get_commit_file_changes(
    repo_path: String,
    commit_hash: String
) -> Result<Vec<CommitFileChange>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let oid = Oid::from_str(&commit_hash).map_err(|error| error.to_string())?;

    let commit = repo.find_commit(oid).map_err(|error| error.to_string())?;

    let commit_tree = commit.tree().map_err(|error| error.to_string())?;

    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|error| error.to_string())?
                .tree()
                .map_err(|error| error.to_string())?
        )
    } else {
        None
    };

    let mut diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
        .map_err(|error| error.to_string())?;

    diff.find_similar(None).map_err(|error| error.to_string())?;

    let mut changes = Vec::new();

    for (index, delta) in diff.deltas().enumerate() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown file".to_string());

        let status = format!("{:?}", delta.status());

        let patch = Patch::from_diff(&diff, index).map_err(|error| error.to_string())?;

        let (additions, deletions) = match patch {
            Some(patch) => {
                let (_, added, removed) = patch.line_stats().map_err(|error| error.to_string())?;

                (Some(added), Some(removed))
            }
            None => (None, None),
        };

        changes.push(CommitFileChange {
            path,
            status,
            additions,
            deletions,
        });
    }

    Ok(changes)
}

#[tauri::command]
fn switch_branch(repo_path: String, branch_name: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let branch = repo
        .find_branch(&branch_name, BranchType::Local)
        .map_err(|error| error.to_string())?;

    if branch.is_head() {
        return Ok(());
    }

    if repo.state() != RepositoryState::Clean {
        return Err(
            "A Git operation is in progress. Finish or abort it before switching branches.".to_string()
        );
    }

    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut options)).map_err(|error| error.to_string())?;

    if !statuses.is_empty() {
        return Err(
            "Uncommitted changes detected. Commit, stash, or discard your changes before switching branches.".to_string()
        );
    }

    let reference_name = branch
        .get()
        .name()
        .map_err(|error| error.to_string())?
        .to_string();

    let commit = branch
        .get()
        .peel_to_commit()
        .map_err(|error| error.to_string())?;

    let object = repo.find_object(commit.id(), None).map_err(|error| error.to_string())?;

    let mut checkout = CheckoutBuilder::new();
    checkout.safe();

    repo
        .checkout_tree(&object, Some(&mut checkout))
        .map_err(|error| format!("Branch checkout failed: {error}"))?;

    repo.set_head(&reference_name).map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_repository_activity(repo_path: String) -> Result<Vec<ActivityCommit>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let mut revwalk = repo.revwalk().map_err(|error| error.to_string())?;

    let now = std::time::SystemTime
        ::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs() as i64;

    let cutoff = now - 91 * 24 * 60 * 60;

    let references = repo.references().map_err(|error| error.to_string())?;

    for reference in references {
        let reference = reference.map_err(|error| error.to_string())?;

        let name = reference.name().unwrap_or("");

        if !name.starts_with("refs/heads/") && !name.starts_with("refs/remotes/") {
            continue;
        }

        if reference.kind() == Some(ReferenceType::Symbolic) {
            continue;
        }

        let commit = reference.peel_to_commit().map_err(|error| error.to_string())?;

        revwalk.push(commit.id()).map_err(|error| error.to_string())?;
    }

    let mut activity = Vec::new();

    for oid_result in revwalk {
        let oid = oid_result.map_err(|error| error.to_string())?;

        let commit = repo.find_commit(oid).map_err(|error| error.to_string())?;

        let timestamp = commit.time().seconds();

        if timestamp < cutoff || timestamp > now {
            continue;
        }

        let author = commit.author().name().unwrap_or("Unknown").to_string();

        activity.push(ActivityCommit { timestamp, author });
    }

    Ok(activity)
}

#[tauri::command]
fn create_branch(repo_path: String, branch_name: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;
    let name = branch_name.trim();

    if name.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }
    if repo.state() != RepositoryState::Clean {
        return Err("Finish the current Git operation before creating a branch.".to_string());
    }

    let head = repo.head().map_err(|error| error.to_string())?;

    let commit = head.peel_to_commit().map_err(|error| error.to_string())?;

    // false prevents overwriting an existing branch.
    repo.branch(name, &commit, false).map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
fn merge_branches(
    repo_path: String,
    source_branch: String,
    target_branch: String
) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    if source_branch == target_branch {
        return Err("Cannot merge a branch into itself.".to_string());
    }
    if repo.state() != RepositoryState::Clean {
        return Err("Finish or abort the current Git operation before merging.".to_string());
    }
    if repo.head_detached().map_err(|error| error.to_string())? {
        return Err("Check out a local branch before merging.".to_string());
    }

    let mut status_options = StatusOptions::new();

    status_options.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut status_options)).map_err(|error| error.to_string())?;

    if !statuses.is_empty() {
        return Err(
            "Uncommitted changes detected. Commit or stash them before merging.".to_string()
        );
    }

    let source = repo
        .find_branch(&source_branch, BranchType::Local)
        .map_err(|error| error.to_string())?;

    let target = repo
        .find_branch(&target_branch, BranchType::Local)
        .map_err(|error| error.to_string())?;

    let source_commit = source
        .get()
        .peel_to_commit()
        .map_err(|error| error.to_string())?;

    let target_commit = target
        .get()
        .peel_to_commit()
        .map_err(|error| error.to_string())?;

    let up_to_date =
        source_commit.id() == target_commit.id() ||
        repo
            .graph_descendant_of(target_commit.id(), source_commit.id())
            .map_err(|error| error.to_string())?;

    if up_to_date {
        return Ok(format!("{target_branch} already contains {source_branch}."));
    }

    let fast_forward = repo
        .graph_descendant_of(source_commit.id(), target_commit.id())
        .map_err(|error| error.to_string())?;

    if !fast_forward {
        let preview = repo
            .merge_commits(&target_commit, &source_commit, None)
            .map_err(|error| error.to_string())?;

        if preview.has_conflicts() {
            return Err(
                format!(
                    "Cannot automatically merge {source_branch} into \
                 {target_branch}: merge conflicts were detected. \
                 No branches were changed."
                )
            );
        }
    }

    if !target.is_head() {
        let object = repo.find_object(target_commit.id(), None).map_err(|error| error.to_string())?;

        let mut checkout = CheckoutBuilder::new();
        checkout.safe();

        repo.checkout_tree(&object, Some(&mut checkout)).map_err(|error| error.to_string())?;

        let reference_name = target
            .get()
            .name()
            .map_err(|error| error.to_string())?;

        repo.set_head(reference_name).map_err(|error| error.to_string())?;
    }

    if fast_forward {
        let object = repo.find_object(source_commit.id(), None).map_err(|error| error.to_string())?;

        let mut checkout = CheckoutBuilder::new();
        checkout.safe();

        repo.checkout_tree(&object, Some(&mut checkout)).map_err(|error| error.to_string())?;

        let mut target_ref = repo
            .find_reference(&format!("refs/heads/{target_branch}"))
            .map_err(|error| error.to_string())?;

        target_ref
            .set_target(source_commit.id(), "Fast-forward merge")
            .map_err(|error| error.to_string())?;

        return Ok(format!("Fast-forwarded {target_branch} to {source_branch}."));
    }

    let annotated = repo
        .find_annotated_commit(source_commit.id())
        .map_err(|error| error.to_string())?;

    let mut checkout = CheckoutBuilder::new();
    checkout.safe();

    repo.merge(&[&annotated], None, Some(&mut checkout)).map_err(|error| error.to_string())?;

    let mut index = repo.index().map_err(|error| error.to_string())?;

    if index.has_conflicts() {
        return Err(
            "The merge produced conflicts. Resolve or abort \
             the in-progress merge before continuing.".to_string()
        );
    }

    let tree_oid = index.write_tree().map_err(|error| error.to_string())?;

    let tree = repo.find_tree(tree_oid).map_err(|error| error.to_string())?;

    let signature = repo.signature().map_err(|error| error.to_string())?;

    let message = format!("Merge branch '{source_branch}' into {target_branch}");

    repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            &message,
            &tree,
            &[&target_commit, &source_commit]
        )
        .map_err(|error| error.to_string())?;

    repo.cleanup_state().map_err(|error| error.to_string())?;

    Ok(format!("Successfully merged {source_branch} into {target_branch}."))
}

#[tauri::command]
fn save_file(repo_path: String, file_path: String, contents: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot edit files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_path = Path::new(&file_path);

    let target = if supplied_path.is_absolute() {
        supplied_path.to_path_buf()
    } else {
        repo_root.join(supplied_path)
    };

    let resolved = target.canonicalize().map_err(|error| format!("Invalid file path: {error}"))?;

    if !resolved.starts_with(&repo_root) {
        return Err("Cannot save files outside the selected repository.".to_string());
    }

    if !resolved.is_file() {
        return Err("The selected path is not a regular file.".to_string());
    }

    fs::write(&resolved, contents).map_err(|error| format!("Failed to save file: {error}"))?;

    Ok(())
}

#[tauri::command]
fn read_image(repo_path: String, file_path: String) -> Result<Vec<u8>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot read files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_path = Path::new(&file_path);

    let target = if supplied_path.is_absolute() {
        supplied_path.to_path_buf()
    } else {
        repo_root.join(supplied_path)
    };

    let resolved = target.canonicalize().map_err(|error| error.to_string())?;

    if !resolved.starts_with(&repo_root) {
        return Err("Cannot read images outside the repository.".to_string());
    }

    if !resolved.is_file() {
        return Err("The selected path is not a file.".to_string());
    }

    let extension = resolved
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(&extension.as_str()) {
        return Err("Unsupported image format.".to_string());
    }

    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;

    if metadata.len() > 20 * 1024 * 1024 {
        return Err("Image exceeds the 20 MiB size limit.".to_string());
    }

    fs::read(&resolved).map_err(|error| format!("Failed to read image: {error}"))
}

#[tauri::command]
fn read_document(repo_path: String, file_path: String) -> Result<Vec<u8>, String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot read files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_path = std::path::Path::new(&file_path);

    let target = if supplied_path.is_absolute() {
        supplied_path.to_path_buf()
    } else {
        repo_root.join(supplied_path)
    };

    let resolved = target.canonicalize().map_err(|error| error.to_string())?;

    if !resolved.starts_with(&repo_root) {
        return Err("File is outside the selected repository.".to_string());
    }

    if !resolved.is_file() {
        return Err("Selected path is not a regular file.".to_string());
    }

    let extension = resolved
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    if !["pdf", "docx"].contains(&extension.as_str()) {
        return Err("Unsupported document format.".to_string());
    }

    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;

    if metadata.len() > 20 * 1024 * 1024 {
        return Err("Document exceeds the 20 MiB limit.".to_string());
    }

    fs::read(&resolved).map_err(|error| format!("Failed to read document: {error}"))
}

#[tauri::command]
fn create_entry(
    repo_path: String,
    parent_path: String,
    name: String,
    is_directory: bool
) -> Result<(), String> {
    if
        name.is_empty() ||
        name == "." ||
        name == ".." ||
        name.contains('/') ||
        name.contains('\\') ||
        name.contains('\0') ||
        name.eq_ignore_ascii_case(".git")
    {
        return Err("Invalid file or folder name.".to_string());
    }

    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot create files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_parent = Path::new(&parent_path);

    let parent = if supplied_parent.is_absolute() {
        supplied_parent.to_path_buf()
    } else {
        repo_root.join(supplied_parent)
    };

    let resolved_parent = parent.canonicalize().map_err(|error| error.to_string())?;

    if !resolved_parent.starts_with(&repo_root) {
        return Err("Cannot create entries outside the repository.".into());
    }

    if !resolved_parent.is_dir() {
        return Err("The selected parent is not a directory.".into());
    }

    let relative_parent = resolved_parent
        .strip_prefix(&repo_root)
        .map_err(|error| error.to_string())?;

    if
        relative_parent
            .components()
            .any(|component| {
                component.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git")
            })
    {
        return Err("Cannot modify Git metadata.".into());
    }

    let target = resolved_parent.join(&name);

    if is_directory {
        fs::create_dir(&target).map_err(|error| format!("Failed to create folder: {error}"))?;
    } else {
        fs::OpenOptions
            ::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| format!("Failed to create file: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn rename_entry(repo_path: String, entry_path: String, new_name: String) -> Result<(), String> {
    if
        new_name.is_empty() ||
        new_name == "." ||
        new_name == ".." ||
        new_name.contains('/') ||
        new_name.contains('\\') ||
        new_name.contains('\0') ||
        new_name.eq_ignore_ascii_case(".git")
    {
        return Err("Invalid file or folder name.".into());
    }

    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot rename entries in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_path = Path::new(&entry_path);

    let target = if supplied_path.is_absolute() {
        supplied_path.to_path_buf()
    } else {
        repo_root.join(supplied_path)
    };

    let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;

    if metadata.file_type().is_symlink() {
        return Err("Renaming symbolic links is not supported.".into());
    }

    let resolved = target.canonicalize().map_err(|error| error.to_string())?;

    if !resolved.starts_with(&repo_root) || resolved == repo_root {
        return Err("Cannot rename this path.".into());
    }

    let relative_path = resolved.strip_prefix(&repo_root).map_err(|error| error.to_string())?;

    if
        relative_path
            .components()
            .any(|component| {
                component.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git")
            })
    {
        return Err("Cannot modify Git metadata.".into());
    }

    let parent = resolved.parent().ok_or("Could not determine the parent directory.")?;

    let destination = parent.join(&new_name);

    if destination == resolved {
        return Ok(());
    }

    if fs::symlink_metadata(&destination).is_ok() {
        return Err("A file or folder with that name already exists.".into());
    }

    fs
        ::rename(&resolved, &destination)
        .map_err(|error| format!("Failed to rename entry: {error}"))?;

    Ok(())
}

#[tauri::command]
fn delete_entry(repo_path: String, entry_path: String) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot delete files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let supplied_path = Path::new(&entry_path);

    let target = if supplied_path.is_absolute() {
        supplied_path.to_path_buf()
    } else {
        repo_root.join(supplied_path)
    };

    let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;

    if metadata.file_type().is_symlink() {
        return Err("Deleting symbolic links is not supported.".into());
    }

    let resolved = target.canonicalize().map_err(|error| error.to_string())?;

    if !resolved.starts_with(&repo_root) || resolved == repo_root {
        return Err("Cannot delete this path.".into());
    }

    let relative_path = resolved.strip_prefix(&repo_root).map_err(|error| error.to_string())?;

    if
        relative_path
            .components()
            .any(|component| {
                component.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git")
            })
    {
        return Err("Cannot modify Git metadata.".into());
    }

    if metadata.is_dir() && contains_git_metadata(&resolved)? {
        return Err("This directory contains Git metadata and cannot be deleted.".into());
    }

    if metadata.is_dir() {
        fs
            ::remove_dir_all(&resolved)
            .map_err(|error| format!("Failed to delete directory: {error}"))?;
    } else if metadata.is_file() {
        fs::remove_file(&resolved).map_err(|error| format!("Failed to delete file: {error}"))?;
    } else {
        return Err("Unsupported filesystem entry.".into());
    }

    Ok(())
}

fn contains_git_metadata(path: &Path) -> Result<bool, String> {
    if !path.is_dir() {
        return Ok(false);
    }

    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;

        if entry.file_name().to_string_lossy() == ".git" {
            return Ok(true);
        }

        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;

        if metadata.is_dir() && contains_git_metadata(&entry.path())? {
            return Ok(true);
        }
    }

    Ok(false)
}

#[tauri::command]
fn move_entry(
    repo_path: String,
    entry_path: String,
    destination_path: String
) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|error| error.to_string())?;

    let workdir = repo.workdir().ok_or("Cannot move files in a bare repository.")?;

    let repo_root = workdir.canonicalize().map_err(|error| error.to_string())?;

    let resolve = |path: &str| -> Result<PathBuf, String> {
        let supplied = Path::new(path);

        let target = if supplied.is_absolute() {
            supplied.to_path_buf()
        } else {
            repo_root.join(supplied)
        };

        target.canonicalize().map_err(|error| error.to_string())
    };

    let source = resolve(&entry_path)?;
    let destination_dir = resolve(&destination_path)?;

    if !source.starts_with(&repo_root) || !destination_dir.starts_with(&repo_root) {
        return Err("Cannot move files outside the repository.".into());
    }

    if source == repo_root {
        return Err("Cannot move the repository root.".into());
    }

    for path in [&source, &destination_dir] {
        let relative = path.strip_prefix(&repo_root).map_err(|error| error.to_string())?;

        if
            relative
                .components()
                .any(|component| {
                    component.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git")
                })
        {
            return Err("Cannot modify Git metadata.".into());
        }
    }

    let supplied_source = Path::new(&entry_path);

    let original_source = if supplied_source.is_absolute() {
        supplied_source.to_path_buf()
    } else {
        repo_root.join(supplied_source)
    };

    let metadata = fs::symlink_metadata(&original_source).map_err(|error| error.to_string())?;

    if metadata.file_type().is_symlink() {
        return Err("Moving symbolic links is not supported.".into());
    }

    if !metadata.is_file() && !metadata.is_dir() {
        return Err("Unsupported filesystem entry.".into());
    }

    if !destination_dir.is_dir() {
        return Err("Destination must be a directory.".into());
    }

    if metadata.is_dir() && destination_dir.starts_with(&source) {
        return Err("Cannot move a folder inside itself.".into());
    }

    if metadata.is_dir() && contains_git_metadata(&source)? {
        return Err("Cannot move a directory containing Git metadata.".into());
    }

    let filename = source.file_name().ok_or("Could not determine the entry name.")?;

    let destination = destination_dir.join(filename);

    if destination == source {
        return Ok(());
    }

    if fs::symlink_metadata(&destination).is_ok() {
        return Err("A file or folder with that name already exists in the destination.".into());
    }

    fs::rename(&source, &destination).map_err(|error| format!("Failed to move entry: {error}"))?;

    Ok(())
}

#[tauri::command]
fn initialize_repository(
    parent_path: String,
    new_name: Option<String>,
    initial_branch: String
) -> Result<String, String> {
    let parent = Path::new(&parent_path)
        .canonicalize()
        .map_err(|e| format!("Invalid directory: {e}"))?;

    if !parent.is_dir() {
        return Err("The selected location is not a directory.".into());
    }

    let valid_branch = Branch::name_is_valid(&initial_branch).map_err(|e| e.to_string())?;

    if !valid_branch {
        return Err("Invalid Git branch name.".into());
    }

    if Repository::discover(&parent).is_ok() {
        return Err("The selected directory is already inside a Git repository.".into());
    }

    let target = if let Some(name) = new_name {
        if
            name.is_empty() ||
            name == "." ||
            name == ".." ||
            name.contains('/') ||
            name.contains('\\') ||
            name.contains('\0') ||
            name.eq_ignore_ascii_case(".git")
        {
            return Err("Invalid repository name.".into());
        }

        let path = parent.join(name);

        fs::create_dir(&path).map_err(|e| format!("Cannot create repository folder: {e}"))?;

        path
    } else {
        parent
    };

    let mut options = RepositoryInitOptions::new();

    options.bare(false).no_reinit(true).initial_head(&initial_branch);

    Repository::init_opts(&target, &options).map_err(|e|
        format!("Failed to initialize repository: {e}")
    )?;

    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn is_git_repository(path: String) -> Result<bool, String> {
    let directory = std::path::Path
        ::new(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;

    if !directory.is_dir() {
        return Err("Selected path is not a directory.".into());
    }

    match Repository::open(&directory) {
        Ok(repo) => {
            let workdir = match repo.workdir() {
                Some(path) => path,
                None => {
                    return Ok(false);
                }
            };

            Ok(workdir.canonicalize().map_err(|e| e.to_string())? == directory)
        }
        Err(error) if error.code() == ErrorCode::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder
        ::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(
            tauri::generate_handler![
                get_repository_tree,
                read_file,
                stage_file,
                unstage_file,
                commit_changes,
                get_file_diff,
                get_commit_history,
                get_repository_summary,
                get_local_branches,
                get_commit_file_changes,
                switch_branch,
                get_repository_activity,
                create_branch,
                merge_branches,
                save_file,
                read_image,
                read_document,
                create_entry,
                rename_entry,
                delete_entry,
                move_entry,
                initialize_repository,
                is_git_repository
            ]
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
