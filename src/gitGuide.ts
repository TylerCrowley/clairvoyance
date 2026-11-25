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

export interface GitExplanation {
  title: string;
  summary: string;
  details: string;
  command?: string;
  visual?: GitGuideVisual;
}

export type GitGuideVisual =
  | "working-directory"
  | "staging-area"
  | "unstaging"
  | "committing";

export interface GitGuideCategory {
  title: string;
  icon: string;
  topics: Array<keyof typeof gitExplanations>;
}

export const gitGuideCategories: GitGuideCategory[] = [
  {
    title: "Getting Started",
    icon: "folder-git-2",
    topics: ["welcome", "introduction", "repositories", "workingDirectory"],
  },
  {
    title: "Tracking Changes",
    icon: "file-diff",
    topics: ["status", "diffing", "staging", "unstaging", "ignoring"],
  },
  {
    title: "Saving Progress",
    icon: "git-commit-horizontal",
    topics: ["committing", "history", "head"],
  },
  {
    title: "Branching",
    icon: "git-branch",
    topics: [
      "branching",
      "creatingBranches",
      "switchingBranches",
      "merging",
      "conflicts",
    ],
  },
  {
    title: "Collaboration",
    icon: "globe",
    topics: ["remotes", "fetching", "pulling", "pushing"],
  },
];

export const gitExplanations: Record<string, GitExplanation> = {

  // -- Getting Started --

  welcome: {
    title: "Welcome to Git",
    summary: "Learn version control by exploring real repositories.",
    details:
      "Clairvoyance helps you understand Git as you work with your files. " +
      "Use Browse Topics to explore Git concepts, see their corresponding " +
      "terminal commands, and learn how Git manages your projects. " +
      "You can follow along using a repository of your own.",
  },

  introduction: {
    title: "What Is Git?",
    summary: "Git is a distributed version control system.",
    details:
      "Git tracks changes to files over time, allowing you to review " +
      "previous versions, experiment safely, and collaborate with others. " +
      "Unlike a simple backup system, Git records snapshots of your project " +
      "and connects them into a history. Each developer can maintain a " +
      "complete local copy of that history.",
    command: "git --version",
  },

  repositories: {
    title: "Repositories",
    summary: "A repository contains your project and its version history.",
    details:
      "A Git repository stores commits, branches, configuration, and other " +
      "information Git needs to track your project. Most repositories have " +
      "a hidden .git directory containing this metadata. Initializing a " +
      "repository allows Git to begin tracking changes, but files are not " +
      "automatically committed. Clairvoyance can open existing repositories " +
      "or initialize new ones.",
    command: "git init",
  },

  workingDirectory: {
    title: "Working Directory",
    summary: "The working directory contains the files you actively edit.",
    details:
      "When you modify, create, or delete files in your project, those " +
      "changes first exist in your working directory. Git can compare " +
      "these files against its recorded state to identify changes. " +
      "Editing a tracked file does not automatically include the new " +
      "version in your next commit. You must first stage the changes.",
    command: "git status",
    visual: "working-directory",
  },

  // -- Tracking Changes --

  status: {
    title: "File Status",
    summary: "Git identifies which files have changed.",
    details:
      "Files may be untracked, modified, staged, deleted, or otherwise " +
      "changed. Untracked files have not been added to Git's index. " +
      "Modified files differ from their recorded version. Staged changes " +
      "are prepared for the next commit. A file can have both staged " +
      "and unstaged changes at the same time. Clairvoyance displays " +
      "these states using indicators in the Explorer.",
    command: "git status",
    visual: "working-directory",
  },

  diffing: {
    title: "Understanding Diffs",
    summary: "A diff shows the differences between versions of a file.",
    details:
      "Git displays file changes as additions, removals, and unchanged " +
      "context lines. Lines beginning with + represent additions, while " +
      "lines beginning with - represent removals. A diff normally shows " +
      "only the affected sections of a file, rather than the entire file. " +
      "Reviewing differences helps you understand what changed before " +
      "you stage or commit your work.",
    command: "git diff",
    visual: "working-directory",
  },

  staging: {
    title: "Staging Changes",
    summary: "Choose which changes to include in your next commit.",
    details:
      "The staging area, also called the index, holds the snapshot Git " +
      "will use to create your next commit. Staging a file copies its " +
      "current contents into the index. This lets you prepare a commit " +
      "without including every change in your working directory. " +
      "If you modify a file again after staging it, you must stage " +
      "the newer version to include those additional changes.",
    command: "git add <file>",
    visual: "staging-area",
  },

  unstaging: {
    title: "Unstaging Changes",
    summary: "Remove changes from the staging area.",
    details:
      "Unstaging a file removes its changes from the proposed commit " +
      "without discarding the changes in your working directory. " +
      "This is useful when you accidentally stage a file or decide " +
      "that certain changes belong in a different commit. " +
      "Unstaging is not the same as reverting or deleting your edits.",
    command: "git restore --staged <file>",
    visual: "unstaging",
  },

  ignoring: {
    title: "Ignoring Files",
    summary: "Tell Git which untracked files it should ignore.",
    details:
      "A .gitignore file contains patterns for files and directories " +
      "that Git should normally leave untracked. Common examples " +
      "include temporary files, build outputs, and local configuration. " +
      "Ignoring a file does not delete it, and adding an already tracked " +
      "file to .gitignore does not automatically stop tracking it. " +
      "The .gitignore file itself can be committed and shared.",
    command: "git status --ignored",
  },

  // -- Saving Progress --

  committing: {
    title: "Creating Commits",
    summary: "Save a snapshot of your staged changes.",
    details:
      "A commit records the contents of the staging area in your " +
      "repository's history. Every commit has a unique identifier, " +
      "author information, a timestamp, and a commit message. " +
      "Most commits also reference one or more parent commits. " +
      "Good commit messages describe the purpose of the changes. " +
      "Commits allow you to inspect previous project states and " +
      "understand how a project developed.",
    command: 'git commit -m "Describe your changes"',
    visual: "committing",
  },

  history: {
    title: "Commit History",
    summary: "Explore the snapshots that make up your project's history.",
    details:
      "Git organizes commits into a connected history. Each commit " +
      "contains a reference to its parent or parents, forming a " +
      "directed graph of development. Clairvoyance displays this " +
      "history with commit messages, identifiers, authors, dates, " +
      "and visual connections. Examining history helps identify " +
      "when and why changes were introduced.",
    command: "git log --oneline --graph --all",
  },

  head: {
    title: "Understanding HEAD",
    summary: "HEAD identifies your current position in Git's history.",
    details:
      "HEAD normally refers to the branch you currently have checked " +
      "out. That branch points to a commit, which represents the " +
      "current recorded state of your project. When you create a " +
      "commit on that branch, its reference advances to the new commit. " +
      "Git can also enter a detached HEAD state, where HEAD points " +
      "directly to a commit instead of a branch.",
    command: "git rev-parse HEAD",
  },

  // -- Branching --

  branching: {
    title: "Understanding Branches",
    summary: "Branches allow multiple lines of development.",
    details:
      "A branch is a movable reference to a commit. Branches let " +
      "you develop features, experiment, or fix bugs without immediately " +
      "changing another branch. Creating a branch does not duplicate " +
      "the entire repository. Instead, Git creates a new reference " +
      "to an existing commit. As new commits are made, the current " +
      "branch advances independently.",
    command: "git branch",
  },

  creatingBranches: {
    title: "Creating Branches",
    summary: "Start a new line of development.",
    details:
      "Creating a branch establishes a new reference to a commit, " +
      "usually your current commit. The new branch begins with the " +
      "same history as its starting point. You can then switch to " +
      "it and make additional commits without moving the original " +
      "branch. Common branch names describe features, fixes, " +
      "or other areas of work.",
    command: "git branch feature-name",
  },

  switchingBranches: {
    title: "Switching Branches",
    summary: "Move between different lines of development.",
    details:
      "Switching branches updates HEAD and normally updates your " +
      "working directory to reflect the selected branch. " +
      "Files may appear, disappear, or change as a result. " +
      "Git protects against switching when local changes would " +
      "be overwritten. Committing or otherwise safely preserving " +
      "your changes before switching can prevent problems.",
    command: "git switch feature-name",
  },

  merging: {
    title: "Merging Branches",
    summary: "Combine changes from different development histories.",
    details:
      "Merging incorporates changes from one branch into another. " +
      "If the target branch has not diverged, Git may simply " +
      "advance it through a fast-forward merge. Otherwise, Git " +
      "attempts a three-way merge and may create a merge commit " +
      "with multiple parents. Merging preserves the history " +
      "of the combined lines of development.",
    command: "git merge feature-name",
  },

  conflicts: {
    title: "Merge Conflicts",
    summary: "Sometimes Git needs help combining changes.",
    details:
      "A merge conflict occurs when Git cannot safely combine " +
      "changes automatically. This commonly happens when two " +
      "branches modify overlapping lines differently, or when " +
      "their changes to a file are incompatible. Conflicts must " +
      "be resolved by deciding which content to keep. After " +
      "resolving the files, you stage the results and complete " +
      "the merge. Clairvoyance may require an external Git tool " +
      "for conflicts it cannot resolve.",
    command: "git status",
  },

  // -- Collaboration --

  remotes: {
    title: "Remote Repositories",
    summary: "A remote is a named connection to another repository.",
    details:
      "Git can exchange commits and references with repositories " +
      "stored elsewhere, commonly on services such as GitHub or GitLab. " +
      "A remote is typically identified by a name such as origin " +
      "and an associated URL. Remotes enable collaboration, but " +
      "Git itself does not require an internet connection for " +
      "normal local operations.",
    command: "git remote -v",
  },

  fetching: {
    title: "Fetching Changes",
    summary: "Retrieve remote updates without merging them.",
    details:
      "Fetching downloads available commits and updates remote-tracking " +
      "references, such as origin/main. It does not normally change " +
      "your current branch or working directory. Fetching lets you " +
      "inspect changes from another repository before deciding " +
      "whether to incorporate them into your work.",
    command: "git fetch origin",
  },

  pulling: {
    title: "Pulling Changes",
    summary: "Retrieve remote changes and integrate them locally.",
    details:
      "Pulling generally performs a fetch followed by integration " +
      "into your current branch. Depending on repository configuration, " +
      "that integration may use a merge or a rebase. Pulling can change " +
      "your local branch and working directory, and may produce " +
      "conflicts that require resolution.",
    command: "git pull",
  },

  pushing: {
    title: "Pushing Changes",
    summary: "Share your local commits with another repository.",
    details:
      "Pushing sends commits and updates branch references in a " +
      "remote repository. This allows collaborators to access " +
      "your work. Git may reject a push when the remote branch " +
      "contains commits your local branch has not incorporated. " +
      "In that case, you should inspect and integrate the " +
      "remote changes before attempting to push again.",
    command: "git push origin main",
  },
};
