// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
struct TreeEntry {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<TreeEntry>,
}

fn build_tree(dir: &Path, root: &Path) -> Result<TreeEntry, String> {
    let mut children = Vec::new();

    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        // Skip generated or internal directories.
        if path.is_dir() && matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
            continue;
        }

        let is_dir = path.is_dir();

        let nested = if is_dir {
            Some(build_tree(&path, root)?)
        } else {
            None
        };

        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        children.push(TreeEntry {
            name,
            path: relative_path,
            is_dir,
            children: nested.map(|node| node.children).unwrap_or_default(),
        });
    }

    // Show directories first, then sort alphabetically.
    children.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let name = dir
        .file_name()
        .unwrap_or(dir.as_os_str())
        .to_string_lossy()
        .into_owned();

    let relative_path = dir
        .strip_prefix(root)
        .unwrap_or(dir)
        .to_string_lossy()
        .replace('\\', "/");

    Ok(TreeEntry {
        name,
        path: relative_path,
        is_dir: true,
        children,
    })
}

#[tauri::command]
fn get_repository_tree(path: String) -> Result<TreeEntry, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err("Selected path is not a directory".to_string());
    }
    build_tree(&root, &root)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![greet])
        .invoke_handler(tauri::generate_handler![get_repository_tree])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
