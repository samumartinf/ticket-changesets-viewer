# Ticket Changesets Viewer

A Visual Studio Code extension that helps you easily find and view all SVN changesets associated with a ticket ID. 

![Ticket Changesets Viewer](resources/screenshot.png)

## Features

- **Search by Ticket ID**: Find all SVN revisions that mention a specific ticket ID
- **View Commit Details**: See commit messages, authors, dates, and changed files
- **Syntax-Highlighted Diffs**: Review code changes with proper syntax highlighting
- **VS Code Diff Editor Integration**: Open changes in VS Code's native diff editor
- **Unified Diff View**: See the cumulative effect of all changes on a specific file

## Requirements

- Subversion (SVN) command-line client installed and available in PATH
- A working SVN repository

## Usage

1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS) to open the Command Palette
2. Type "Show Ticket Changesets" and select the command
3. Enter a ticket ID (e.g., 52438)
4. Review the list of changesets
5. Use the "Show Diff" button to view changes inline
6. Use the "Open in Diff Editor" button to view a specific revision in VS Code's diff editor
7. Use the "View Unified Diff" button to see cumulative changes to a file across all revisions

## Extension Settings

This extension contributes the following settings:

* `ticketChangesetsViewer.svnPath`: Path to the SVN executable (default: "svn")

## Known Issues

- SVN must be installed and accessible from the command line
- Large diffs may take a moment to load 
- Paths with spaces may not work properly in some SVN configurations

## Release Notes

### 1.0.0

Initial release of Ticket Changesets Viewer

---

## Working with the Extension

* Start by searching for a ticket ID
* Review the list of changesets associated with your ticket
* Use various diff views to understand code changes

## For More Information

* [Source Code](https://github.com/YOUR-USERNAME/ticket-changesets-viewer)
* [Issue Tracker](https://github.com/YOUR-USERNAME/ticket-changesets-viewer/issues)

**Enjoy!** 