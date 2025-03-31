import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const execAsync = promisify(exec);

interface Changeset {
    revision: string;
    author: string;
    date: string;
    message: string;
    files: string[];
}

// Create an output channel for logging
const outputChannel = vscode.window.createOutputChannel('Ticket Changesets');

export function activate(context: vscode.ExtensionContext) {
    // Log that we're activating
    outputChannel.appendLine('Ticket Changesets extension is activating...');
    outputChannel.show();

    let disposable = vscode.commands.registerCommand('ticket-changesets-viewer.showChanges', async () => {
        outputChannel.appendLine('Command "Show Ticket Changesets" was triggered');
        try {
            // First, get the SVN working directory
            const workingDir = await getSvnWorkingDir();
            if (!workingDir) {
                vscode.window.showErrorMessage('Please open a folder that is an SVN working copy');
                return;
            }
            outputChannel.appendLine(`Using SVN working directory: ${workingDir}`);

            // Get the ticket ID from the user
            const ticketId = await vscode.window.showInputBox({
                prompt: 'Enter ticket ID (e.g., 52438)',
                placeHolder: '52438',
                validateInput: (value) => {
                    return /^\d+$/.test(value) ? null : 'Please enter a valid ticket ID (numbers only)';
                }
            });

            if (!ticketId) {
                outputChannel.appendLine('No ticket ID entered, cancelling...');
                return;
            }

            outputChannel.appendLine(`Searching for changesets related to ticket #${ticketId}`);

            // Show progress indicator
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Fetching changesets",
                cancellable: false
            }, async (progress) => {
                progress.report({ message: "Getting SVN log entries..." });

                // Get SVN path from settings
                const config = vscode.workspace.getConfiguration('ticketChangesetsViewer');
                const svnPath = config.get<string>('svnPath') || 'svn';
                outputChannel.appendLine(`Using SVN path: ${svnPath}`);

                // Use the -search option to filter logs for the ticket ID
                outputChannel.appendLine(`Searching for commits containing #${ticketId}...`);
                
                try {
                    // Use the -search option to filter logs for the ticket ID
                    const { stdout: logOutput } = await execAsync(
                        `${svnPath} log -v --search "#${ticketId}"`,
                        { 
                            cwd: workingDir,
                            maxBuffer: 1024 * 1024 * 10 // 10MB buffer
                        }
                    );
                    
                    const changesets = parseSvnLog(logOutput, ticketId);
                    outputChannel.appendLine(`Found ${changesets.length} changesets for ticket #${ticketId}`);

                    if (changesets.length === 0) {
                        vscode.window.showInformationMessage(`No changesets found for ticket #${ticketId}`);
                        return;
                    }

                    // Create a summary view of all changesets
                    let summaryContent = `# Changesets for Ticket #${ticketId}\n\n`;
                    summaryContent += `Found ${changesets.length} changesets associated with this ticket.\n\n`;
                    
                    // Sort changesets by revision number (newest first)
                    changesets.sort((a, b) => parseInt(b.revision) - parseInt(a.revision));
                    
                    for (const changeset of changesets) {
                        summaryContent += `## Revision ${changeset.revision}\n\n`;
                        summaryContent += `**Author:** ${changeset.author}\n\n`;
                        summaryContent += `**Date:** ${changeset.date}\n\n`;
                        summaryContent += `**Message:**\n\`\`\`\n${changeset.message}\n\`\`\`\n\n`;
                        summaryContent += `**Changed Files:**\n\`\`\`\n${changeset.files.join('\n')}\n\`\`\`\n\n`;
                        summaryContent += `---\n\n`;
                    }
                    
                    // Create a summary document
                    const summaryDoc = await vscode.workspace.openTextDocument({
                        content: summaryContent,
                        language: 'markdown'
                    });
                    
                    // Show the summary
                    await vscode.window.showTextDocument(summaryDoc, {
                        preview: false
                    });
                    
                    // Create a webview panel to display changesets with diffs
                    const panel = vscode.window.createWebviewPanel(
                        'ticketChangesets',
                        `Ticket #${ticketId} Changesets`,
                        vscode.ViewColumn.One,
                        {
                            enableScripts: true,
                            retainContextWhenHidden: true
                        }
                    );
                    
                    // Generate HTML content for the webview
                    panel.webview.html = await generateWebviewContent(changesets, workingDir, svnPath, ticketId);
                    
                    // Handle messages from the webview
                    panel.webview.onDidReceiveMessage(async (message) => {
                        if (message.command === 'loadDiff') {
                            try {
                                const revision = message.revision;
                                outputChannel.appendLine(`Loading diff for revision ${revision}...`);
                                
                                // Get the diff for this revision
                                const { stdout: diffOutput } = await execAsync(
                                    `${svnPath} diff -c ${revision}`,
                                    { 
                                        cwd: workingDir,
                                        maxBuffer: 1024 * 1024 * 10 // 10MB buffer for diffs
                                    }
                                );
                                
                                // Send the diff back to the webview
                                panel.webview.postMessage({
                                    command: 'diffLoaded',
                                    diff: diffOutput,
                                    index: message.index
                                });
                                
                                outputChannel.appendLine(`Sent diff for revision ${revision} back to webview`);
                            } catch (error) {
                                const errorMessage = error instanceof Error ? error.message : String(error);
                                outputChannel.appendLine(`Error loading diff: ${errorMessage}`);
                                
                                panel.webview.postMessage({
                                    command: 'diffLoaded',
                                    diff: `Error loading diff: ${errorMessage}`,
                                    index: message.index
                                });
                            }
                        } 
                        else if (message.command === 'openInDiffEditor') {
                            try {
                                const revision = message.revision;
                                outputChannel.appendLine(`Opening diff for revision ${revision} in VS Code diff editor...`);
                                
                                // Get the list of files changed in this revision
                                const { stdout: fileListOutput } = await execAsync(
                                    `${svnPath} log -v -c ${revision}`,
                                    { 
                                        cwd: workingDir,
                                        maxBuffer: 1024 * 1024 * 10 // 10MB buffer for diffs
                                    }
                                );
                                
                                // Parse the files from the log output
                                const changedFiles = extractChangedFilesFromLog(fileListOutput);
                                outputChannel.appendLine(`Found ${changedFiles.length} changed files in revision ${revision}`);
                                
                                if (changedFiles.length === 0) {
                                    vscode.window.showWarningMessage(`No changed files found in revision ${revision}`);
                                    return;
                                }
                                
                                // If more than one file was changed, let the user select which one to view
                                let selectedFile = changedFiles[0];
                                if (changedFiles.length > 1) {
                                    const selectedFileName = await vscode.window.showQuickPick(changedFiles, {
                                        placeHolder: 'Select a file to view diff',
                                        title: `Select file from revision ${revision}`
                                    });
                                    
                                    if (!selectedFileName) {
                                        return; // User cancelled
                                    }
                                    
                                    selectedFile = selectedFileName;
                                }
                                
                                // Create temp files for the diff view
                                const prevRevision = parseInt(revision) - 1;
                                const fileNameOnly = path.basename(selectedFile);
                                
                                // Create temp files
                                const oldVersionPath = path.join(os.tmpdir(), `r${prevRevision}_${fileNameOnly}`);
                                const newVersionPath = path.join(os.tmpdir(), `r${revision}_${fileNameOnly}`);
                                
                                // Get previous version of the file
                                try {
                                    // Fix the file path by removing the leading slash and any duplicate repository folder names
                                    // If the path starts with /trunk/ and workingDir ends with trunk, we need to adjust
                                    let adjustedFilePath = selectedFile;
                                    
                                    // Log the file path and working directory to help debug
                                    outputChannel.appendLine(`Working with file: ${selectedFile}`);
                                    outputChannel.appendLine(`Working directory: ${workingDir}`);
                                    
                                    // Remove the leading slash if it exists
                                    if (adjustedFilePath.startsWith('/')) {
                                        adjustedFilePath = adjustedFilePath.substring(1);
                                    }
                                    
                                    // Check if we need to adjust the path based on the working directory
                                    const workingDirName = path.basename(workingDir);
                                    if (adjustedFilePath.startsWith(workingDirName + '/')) {
                                        // If the path starts with the same folder name as the working directory, remove that prefix
                                        adjustedFilePath = adjustedFilePath.substring(workingDirName.length + 1);
                                    }
                                    
                                    outputChannel.appendLine(`Adjusted file path: ${adjustedFilePath}`);
                                    
                                    const { stdout: oldContent } = await execAsync(
                                        `${svnPath} cat -r ${prevRevision} "${adjustedFilePath}"`,
                                        { 
                                            cwd: workingDir,
                                            maxBuffer: 1024 * 1024 * 10
                                        }
                                    );
                                    
                                    fs.writeFileSync(oldVersionPath, oldContent);
                                    outputChannel.appendLine(`Created temp file for r${prevRevision}: ${oldVersionPath}`);
                                } catch (error) {
                                    outputChannel.appendLine(`Error getting r${prevRevision} of file: ${error}`);
                                    fs.writeFileSync(oldVersionPath, ''); // Empty file if can't get previous version
                                }
                                
                                // Get new version of the file
                                try {
                                    // Use the same path adjustment logic as above
                                    let adjustedFilePath = selectedFile;
                                    
                                    // Remove the leading slash if it exists
                                    if (adjustedFilePath.startsWith('/')) {
                                        adjustedFilePath = adjustedFilePath.substring(1);
                                    }
                                    
                                    // Check if we need to adjust the path based on the working directory
                                    const workingDirName = path.basename(workingDir);
                                    if (adjustedFilePath.startsWith(workingDirName + '/')) {
                                        // If the path starts with the same folder name as the working directory, remove that prefix
                                        adjustedFilePath = adjustedFilePath.substring(workingDirName.length + 1);
                                    }
                                    
                                    const { stdout: newContent } = await execAsync(
                                        `${svnPath} cat -r ${revision} "${adjustedFilePath}"`,
                                        { 
                                            cwd: workingDir,
                                            maxBuffer: 1024 * 1024 * 10
                                        }
                                    );
                                    
                                    fs.writeFileSync(newVersionPath, newContent);
                                    outputChannel.appendLine(`Created temp file for r${revision}: ${newVersionPath}`);
                                } catch (error) {
                                    outputChannel.appendLine(`Error getting r${revision} of file: ${error}`);
                                    vscode.window.showErrorMessage(`Error getting revision ${revision} of file: ${error}`);
                                    return;
                                }
                                
                                // Open diff in VS Code editor
                                const oldUri = vscode.Uri.file(oldVersionPath);
                                const newUri = vscode.Uri.file(newVersionPath);
                                
                                const title = `${path.basename(selectedFile)} (r${prevRevision} → r${revision})`;
                                await vscode.commands.executeCommand('vscode.diff', 
                                    oldUri, 
                                    newUri, 
                                    title
                                );
                                
                                outputChannel.appendLine(`Opened diff view for ${selectedFile} between r${prevRevision} and r${revision}`);
                                
                            } catch (error) {
                                const errorMessage = error instanceof Error ? error.message : String(error);
                                outputChannel.appendLine(`Error opening diff in editor: ${errorMessage}`);
                                vscode.window.showErrorMessage(`Error opening diff: ${errorMessage}`);
                            }
                        }
                        else if (message.command === 'showUnifiedDiff') {
                            try {
                                outputChannel.appendLine(`Creating unified diff for ticket #${ticketId}...`);
                                
                                // Collect all unique files changed across all revisions for this ticket
                                const allChangedFiles = new Set<string>();
                                for (const changeset of changesets) {
                                    // Extract file paths from the changeset files array
                                    changeset.files.forEach(file => {
                                        // Extract just the path part
                                        const fileMatch = file.match(/\s*([AMD])\s+\/?(.+)/);
                                        if (fileMatch) {
                                            const filePath = fileMatch[2];  // path without leading slash
                                            allChangedFiles.add(filePath);
                                        } else {
                                            allChangedFiles.add(file);
                                        }
                                    });
                                }
                                
                                const uniqueFiles = Array.from(allChangedFiles);
                                outputChannel.appendLine(`Found ${uniqueFiles.length} unique files changed across all revisions`);
                                
                                if (uniqueFiles.length === 0) {
                                    vscode.window.showWarningMessage(`No files found across revisions for ticket #${ticketId}`);
                                    return;
                                }
                                
                                // If more than one file was changed, let the user select which one to view
                                let selectedFile: string;
                                if (uniqueFiles.length > 1) {
                                    const selectedFileName = await vscode.window.showQuickPick(uniqueFiles, {
                                        placeHolder: 'Select a file to view unified diff',
                                        title: `Select file for unified diff across ticket #${ticketId}`
                                    });
                                    
                                    if (!selectedFileName) {
                                        return; // User cancelled
                                    }
                                    
                                    selectedFile = selectedFileName;
                                } else {
                                    selectedFile = uniqueFiles[0];
                                }
                                
                                // Find the lowest and highest revision for this file
                                const revisionsWithFile = changesets
                                    .filter(changeset => 
                                        changeset.files.some(file => 
                                            file.includes(selectedFile)
                                        )
                                    )
                                    .map(changeset => parseInt(changeset.revision))
                                    .sort((a, b) => a - b);
                                
                                if (revisionsWithFile.length === 0) {
                                    vscode.window.showWarningMessage(`Could not find revisions for ${selectedFile}`);
                                    return;
                                }
                                
                                const lowestRevision = revisionsWithFile[0] - 1; // One before the first change
                                const highestRevision = revisionsWithFile[revisionsWithFile.length - 1];
                                
                                outputChannel.appendLine(`Creating unified diff for ${selectedFile} from r${lowestRevision} to r${highestRevision}`);
                                
                                // Prepare the file path
                                let adjustedFilePath = selectedFile;
                                if (adjustedFilePath.startsWith('/')) {
                                    adjustedFilePath = adjustedFilePath.substring(1);
                                }
                                
                                const workingDirName = path.basename(workingDir);
                                if (adjustedFilePath.startsWith(workingDirName + '/')) {
                                    adjustedFilePath = adjustedFilePath.substring(workingDirName.length + 1);
                                }
                                
                                // Create temp files for the diff view
                                const fileNameOnly = path.basename(adjustedFilePath);
                                const oldVersionPath = path.join(os.tmpdir(), `r${lowestRevision}_${fileNameOnly}`);
                                const newVersionPath = path.join(os.tmpdir(), `r${highestRevision}_${fileNameOnly}`);
                                
                                // Get the earliest version of the file
                                try {
                                    // For added files, the earliest version might not exist
                                    try {
                                        const { stdout: oldContent } = await execAsync(
                                            `${svnPath} cat -r ${lowestRevision} "${adjustedFilePath}"`,
                                            { 
                                                cwd: workingDir,
                                                maxBuffer: 1024 * 1024 * 10
                                            }
                                        );
                                        
                                        fs.writeFileSync(oldVersionPath, oldContent);
                                        outputChannel.appendLine(`Created temp file for r${lowestRevision}: ${oldVersionPath}`);
                                    } catch (error) {
                                        outputChannel.appendLine(`Error getting r${lowestRevision} of file (likely new file): ${error}`);
                                        fs.writeFileSync(oldVersionPath, ''); // Empty file if can't get earliest version
                                    }
                                    
                                    // Get the latest version of the file
                                    const { stdout: newContent } = await execAsync(
                                        `${svnPath} cat -r ${highestRevision} "${adjustedFilePath}"`,
                                        { 
                                            cwd: workingDir,
                                            maxBuffer: 1024 * 1024 * 10
                                        }
                                    );
                                    
                                    fs.writeFileSync(newVersionPath, newContent);
                                    outputChannel.appendLine(`Created temp file for r${highestRevision}: ${newVersionPath}`);
                                    
                                    // Open diff in VS Code editor
                                    const oldUri = vscode.Uri.file(oldVersionPath);
                                    const newUri = vscode.Uri.file(newVersionPath);
                                    
                                    const title = `${fileNameOnly} (Unified Diff r${lowestRevision} → r${highestRevision})`;
                                    await vscode.commands.executeCommand('vscode.diff', 
                                        oldUri, 
                                        newUri, 
                                        title
                                    );
                                    
                                    outputChannel.appendLine(`Opened unified diff view for ${adjustedFilePath}`);
                                    
                                } catch (error) {
                                    const errorMessage = error instanceof Error ? error.message : String(error);
                                    outputChannel.appendLine(`Error creating unified diff: ${errorMessage}`);
                                    vscode.window.showErrorMessage(`Error creating unified diff: ${errorMessage}`);
                                }
                                
                            } catch (error) {
                                const errorMessage = error instanceof Error ? error.message : String(error);
                                outputChannel.appendLine(`Error creating unified diff: ${errorMessage}`);
                                vscode.window.showErrorMessage(`Error creating unified diff: ${errorMessage}`);
                            }
                        }
                    });
                    
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    outputChannel.appendLine(`Error searching for commits: ${errorMessage}`);
                    vscode.window.showErrorMessage(`Error searching for commits: ${errorMessage}`);
                }
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`Error: ${errorMessage}`);
            vscode.window.showErrorMessage(`Error: ${errorMessage}`);
        }
    });

    context.subscriptions.push(disposable);
    outputChannel.appendLine('Ticket Changesets extension is now active!');
    vscode.window.showInformationMessage('Ticket Changesets extension is now active!');
}

async function getSvnWorkingDir(): Promise<string | undefined> {
    // First try to use the workspace folder
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
        try {
            // Check if this is an SVN working copy
            await execAsync('svn info', { cwd: workspaceFolder });
            return workspaceFolder;
        } catch (error) {
            outputChannel.appendLine(`Workspace folder is not an SVN working copy: ${error}`);
        }
    }

    // If no workspace folder or not an SVN working copy, ask the user
    const result = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select SVN Working Copy',
        title: 'Select SVN Working Copy Directory'
    });

    if (result && result.length > 0) {
        const selectedPath = result[0].fsPath;
        try {
            // Verify this is an SVN working copy
            await execAsync('svn info', { cwd: selectedPath });
            return selectedPath;
        } catch (error) {
            outputChannel.appendLine(`Selected folder is not an SVN working copy: ${error}`);
            vscode.window.showErrorMessage('Selected folder is not an SVN working copy');
            return undefined;
        }
    }

    return undefined;
}

function parseSvnLog(logOutput: string, ticketId: string): Changeset[] {
    const changesets: Changeset[] = [];
    const lines = logOutput.split('\n');
    let currentChangeset: Partial<Changeset> = {};
    let inMessage = false;
    let messageLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Start of a new changeset
        if (line.startsWith('------------------------------------------------------------------------')) {
            if (currentChangeset.revision && messageLines.length > 0) {
                // Join message lines and check if it contains the ticket ID
                currentChangeset.message = messageLines.join('\n');
                if (currentChangeset.message.includes(`#${ticketId}`)) {
                    changesets.push(currentChangeset as Changeset);
                }
            }
            currentChangeset = {};
            inMessage = false;
            messageLines = [];
            continue;
        }

        // Parse revision line
        if (line.startsWith('r')) {
            const match = line.match(/r(\d+)\s+\|\s+(\w+)\s+\|\s+([^|]+)/);
            if (match) {
                currentChangeset.revision = match[1];
                currentChangeset.author = match[2];
                currentChangeset.date = match[3].trim();
                currentChangeset.files = [];
            }
            continue;
        }

        // Parse changed files
        if (line.startsWith('Changed paths:')) {
            inMessage = false;
            continue;
        }

        if (line.startsWith('   ')) {
            const fileMatch = line.match(/\s*([A-Z])\s+(.+)/);
            if (fileMatch) {
                currentChangeset.files?.push(fileMatch[2]);
            }
            continue;
        }

        // Parse commit message
        if (line.trim() === '') {
            inMessage = true;
            continue;
        }

        if (inMessage) {
            messageLines.push(line.trim());
        }
    }

    // Add the last changeset if it matches
    if (currentChangeset.revision && messageLines.length > 0) {
        currentChangeset.message = messageLines.join('\n');
        if (currentChangeset.message.includes(`#${ticketId}`)) {
            changesets.push(currentChangeset as Changeset);
        }
    }

    return changesets;
}

function extractChangedFilesFromLog(logOutput: string): string[] {
    const changedFiles: string[] = [];
    const lines = logOutput.split('\n');
    let inChangedPaths = false;
    
    outputChannel.appendLine(`Parsing log output for changed files:\n${logOutput}`);
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (line.startsWith('Changed paths:')) {
            inChangedPaths = true;
            continue;
        }
        
        if (inChangedPaths) {
            // If we hit a separator line or empty line, we're done with changed paths
            if (line.startsWith('---') || line === '') {
                inChangedPaths = false;
                continue;
            }
            
            // Skip lines that don't start with whitespace followed by a letter (A/M/D)
            if (!line.match(/^\s*[AMD]/)) {
                continue;
            }
            
            // Various formats of changed path lines:
            // "   M /trunk/path/to/file.cs"
            // "M /trunk/path/to/file.cs" 
            // "M trunk/path/to/file.cs"
            const fileMatch = line.match(/\s*([AMD])\s+\/?(.+)/);
            if (fileMatch) {
                const changeType = fileMatch[1]; // A, M, or D
                const filePath = fileMatch[2];  // path without leading slash
                
                outputChannel.appendLine(`Found changed file: ${changeType} ${filePath}`);
                changedFiles.push(filePath);
            }
        }
    }
    
    outputChannel.appendLine(`Extracted ${changedFiles.length} changed files: ${changedFiles.join(', ')}`);
    return changedFiles;
}

async function generateWebviewContent(
    changesets: Changeset[], 
    workingDir: string, 
    svnPath: string, 
    ticketId: string
): Promise<string> {
    // Create the HTML structure
    let html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Ticket #${ticketId} Changesets</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                }
                .changeset {
                    margin-bottom: 30px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 5px;
                    padding: 15px;
                }
                .changeset-header {
                    margin-bottom: 15px;
                }
                .changeset-title {
                    font-size: 1.2em;
                    font-weight: bold;
                    margin-bottom: 5px;
                }
                .changeset-meta {
                    font-size: 0.9em;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 10px;
                }
                .changeset-message {
                    background-color: var(--vscode-textBlockQuote-background);
                    padding: 10px;
                    border-radius: 3px;
                    margin-bottom: 15px;
                    white-space: pre-wrap;
                }
                .changeset-files {
                    margin-bottom: 15px;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                }
                .diff {
                    background-color: var(--vscode-diffEditor-diagonalFill);
                    border-radius: 3px;
                    padding: 10px;
                    overflow: auto;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    white-space: pre;
                    max-height: 500px;
                }
                .diff-toggle {
                    margin-bottom: 10px;
                    cursor: pointer;
                    color: var(--vscode-button-foreground);
                    background-color: var(--vscode-button-background);
                    padding: 5px 10px;
                    border-radius: 3px;
                    border: none;
                    display: inline-block;
                    margin-right: 10px;
                }
                .diff-toggle:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .diff-container {
                    display: none;
                }
                .diff-container.active {
                    display: block;
                }
                .file {
                    margin-bottom: 5px;
                }
                .add {
                    color: var(--vscode-gitDecoration-addedResourceForeground);
                }
                .delete {
                    color: var(--vscode-gitDecoration-deletedResourceForeground);
                }
                .modify {
                    color: var(--vscode-gitDecoration-modifiedResourceForeground);
                }
                .button-container {
                    margin-bottom: 10px;
                }
                .top-actions {
                    margin-bottom: 20px;
                }
            </style>
        </head>
        <body>
            <h1>Changesets for Ticket #${ticketId}</h1>
            <p>Found ${changesets.length} changesets associated with this ticket.</p>
            
            <div class="top-actions">
                <button class="diff-toggle" onclick="showUnifiedDiff()">View Unified Diff (All Changes)</button>
            </div>
            
            <div id="changesets">
    `;

    // Sort changesets by revision number (newest first)
    changesets.sort((a, b) => parseInt(b.revision) - parseInt(a.revision));

    // Add each changeset to the HTML
    for (const [index, changeset] of changesets.entries()) {
        html += `
            <div class="changeset">
                <div class="changeset-header">
                    <div class="changeset-title">Revision ${changeset.revision}</div>
                    <div class="changeset-meta">
                        <div>Author: ${changeset.author}</div>
                        <div>Date: ${changeset.date}</div>
                    </div>
                </div>
                <div class="changeset-message">${changeset.message}</div>
                <div class="changeset-files">
                    <div>Changed files:</div>
        `;

        // Add file list with formatting based on change type
        for (const file of changeset.files) {
            const changeType = file.charAt(0);
            let cssClass = '';
            if (changeType === 'A') cssClass = 'add';
            else if (changeType === 'D') cssClass = 'delete';
            else if (changeType === 'M') cssClass = 'modify';
            
            html += `<div class="file ${cssClass}">${file}</div>`;
        }

        html += `
                </div>
                <div class="button-container">
                    <button class="diff-toggle" id="button-${index}" onclick="toggleDiff('${changeset.revision}', ${index})">Show Diff</button>
                    <button class="diff-toggle" onclick="openInDiffEditor('${changeset.revision}')">Open in Diff Editor</button>
                </div>
                <div id="diff-${index}" class="diff-container">
                    <div class="diff">Loading diff...</div>
                </div>
            </div>
        `;
    }

    // Close the HTML structure and add JavaScript for interactivity
    html += `
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                
                function toggleDiff(revision, index) {
                    const diffContainer = document.getElementById('diff-' + index);
                    const button = document.getElementById('button-' + index);
                    
                    if (diffContainer.classList.contains('active')) {
                        diffContainer.classList.remove('active');
                        button.textContent = 'Show Diff';
                    } else {
                        diffContainer.classList.add('active');
                        button.textContent = 'Hide Diff';
                        
                        // Only load diff if it hasn't been loaded yet
                        const diffContent = diffContainer.querySelector('.diff');
                        if (diffContent.textContent === 'Loading diff...') {
                            console.log('Sending loadDiff message for revision ' + revision);
                            vscode.postMessage({
                                command: 'loadDiff',
                                revision: revision,
                                index: index
                            });
                        }
                    }
                }
                
                function openInDiffEditor(revision) {
                    console.log('Opening revision ' + revision + ' in VS Code diff editor');
                    vscode.postMessage({
                        command: 'openInDiffEditor',
                        revision: revision
                    });
                }
                
                function showUnifiedDiff() {
                    console.log('Creating unified diff across all revisions');
                    vscode.postMessage({
                        command: 'showUnifiedDiff'
                    });
                }
                
                window.addEventListener('message', event => {
                    const message = event.data;
                    console.log('Received message:', message);
                    
                    if (message.command === 'diffLoaded') {
                        const diffContainer = document.getElementById('diff-' + message.index);
                        const diffContent = diffContainer.querySelector('.diff');
                        diffContent.textContent = message.diff;
                        
                        // Apply syntax highlighting (basic)
                        diffContent.innerHTML = diffContent.textContent
                            .replace(/^\\+.*$/gm, '<span style="color: var(--vscode-gitDecoration-addedResourceForeground);">$&</span>')
                            .replace(/^-.*$/gm, '<span style="color: var(--vscode-gitDecoration-deletedResourceForeground);">$&</span>')
                            .replace(/^@@.*@@/gm, '<span style="color: var(--vscode-editorInfo-foreground);">$&</span>');
                    }
                });
            </script>
        </body>
        </html>
    `;

    return html;
}

export function deactivate() {} 