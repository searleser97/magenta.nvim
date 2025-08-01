import { assertUnreachable } from "../utils/assertUnreachable";
import type { Nvim } from "../nvim/nvim-node";
import { glob } from "glob";
import path from "node:path";
import fs from "node:fs";
import type { MagentaOptions } from "../options";
import { getcwd } from "../nvim/nvim";
import type { Dispatch } from "../tea/tea";
import type { RootMsg } from "../root-msg";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow";
import type { Row0Indexed } from "../nvim/window";
import {
  relativePath,
  resolveFilePath,
  type AbsFilePath,
  type NvimCwd,
  type RelFilePath,
  type UnresolvedFilePath,
  detectFileType,
  FileCategory,
  type FileTypeInfo,
} from "../utils/files";
import type { Result } from "../utils/result";
import * as diff from "diff";
import type { BufferTracker } from "../buffer-tracker";
import { NvimBuffer } from "../nvim/buffer";
import { d, withBindings, withExtmark, withInlineCode } from "../tea/view";
import type { ProviderMessageContent } from "../providers/provider-types";
import { applyInsert, applyReplace } from "../utils/contentEdits";
import { extractPdfText } from "../utils/pdf";
import open from "open";

export type ToolApplication =
  | {
      type: "get-file";
      content: string;
    }
  | {
      type: "get-file-binary";
      mtime: number;
    }
  | {
      type: "insert";
      insertAfter: string;
      content: string;
    }
  | {
      type: "replace";
      find: string;
      replace: string;
    };

export type Msg =
  | {
      type: "add-file-context";
      relFilePath: RelFilePath;
      absFilePath: AbsFilePath;
      fileTypeInfo: FileTypeInfo;
    }
  | {
      type: "remove-file-context";
      absFilePath: AbsFilePath;
    }
  | {
      type: "open-file";
      absFilePath: AbsFilePath;
    }
  | {
      type: "tool-applied";
      absFilePath: AbsFilePath;
      tool: ToolApplication;
      fileTypeInfo: FileTypeInfo;
    };

type Files = {
  [absFilePath: AbsFilePath]: {
    relFilePath: RelFilePath;
    fileTypeInfo: FileTypeInfo;
    /** What was the last update we sent to the agent about this file?
     */
    agentView:
      | { type: "text"; content: string }
      | { type: "binary"; mtime: number }
      | undefined;
  };
};

export type Patch = string & { __patch: true };

export type WholeFileUpdate = {
  type: "whole-file";
  content: string;
};

export type DiffUpdate = {
  type: "diff";
  patch: Patch;
};

export type FileDeletedUpdate = {
  type: "file-deleted";
};

export type FileUpdate = WholeFileUpdate | DiffUpdate | FileDeletedUpdate;

export type FileUpdates = {
  [absFilePath: AbsFilePath]: {
    absFilePath: AbsFilePath;
    relFilePath: RelFilePath;
    update: Result<FileUpdate>;
  };
};

export class ContextManager {
  public files: Files;

  private constructor(
    public myDispatch: Dispatch<Msg>,
    private context: {
      cwd: NvimCwd;
      dispatch: Dispatch<RootMsg>;
      bufferTracker: BufferTracker;
      nvim: Nvim;
      options: MagentaOptions;
    },
    initialFiles: Files = {},
  ) {
    this.files = initialFiles;
  }

  static async create(
    myDispatch: Dispatch<Msg>,
    context: {
      dispatch: Dispatch<RootMsg>;
      cwd: NvimCwd;
      nvim: Nvim;
      options: MagentaOptions;
      bufferTracker: BufferTracker;
    },
  ): Promise<ContextManager> {
    const initialFiles = await ContextManager.loadAutoContext(
      context.nvim,
      context.options,
    );
    return new ContextManager(myDispatch, context, initialFiles);
  }

  reset() {
    // Reset agent view for all files
    for (const absFilePath in this.files) {
      this.files[absFilePath as AbsFilePath].agentView = undefined;
    }
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "add-file-context":
        if (msg.fileTypeInfo.category === FileCategory.UNSUPPORTED) {
          throw new Error(
            `Cannot add ${msg.relFilePath} to context: ${msg.fileTypeInfo.category} files are not supported in context (detected MIME type: ${msg.fileTypeInfo.mimeType})`,
          );
        }

        this.files[msg.absFilePath] = {
          relFilePath: msg.relFilePath,
          fileTypeInfo: msg.fileTypeInfo,
          agentView: undefined,
        };

        return;

      case "remove-file-context": {
        delete this.files[msg.absFilePath];
        return;
      }

      case "open-file": {
        const fileInfo = this.files[msg.absFilePath];

        if (fileInfo && fileInfo.fileTypeInfo.category !== FileCategory.TEXT) {
          // For non-text files (images, PDFs, etc.), use the OS's default application
          open(msg.absFilePath).catch((error: Error) => {
            this.context.nvim.logger.error(
              `Failed to open file with OS: ${error.message}`,
            );
          });
        } else {
          // For text files or files not in context, open in neovim
          openFileInNonMagentaWindow(msg.absFilePath, {
            nvim: this.context.nvim,
            options: this.context.options,
          }).catch((e: Error) => this.context.nvim.logger.error(e.message));
        }

        return;
      }

      case "tool-applied": {
        const relFilePath = relativePath(this.context.cwd, msg.absFilePath);

        // make sure we add the file to context
        if (!this.files[msg.absFilePath]) {
          this.files[msg.absFilePath] = {
            relFilePath,
            fileTypeInfo: msg.fileTypeInfo,
            agentView: undefined,
          };
        }

        this.updateAgentsViewOfFiles(msg.absFilePath, msg.tool);
        return;
      }
      default:
        assertUnreachable(msg);
    }
  }

  isContextEmpty(): boolean {
    return Object.keys(this.files).length == 0;
  }

  private updateAgentsViewOfFiles(
    absFilePath: AbsFilePath,
    tool: ToolApplication,
  ) {
    const fileInfo = this.files[absFilePath];
    if (!fileInfo) {
      throw new Error(`File ${absFilePath} not found in context`);
    }

    switch (tool.type) {
      case "get-file":
        fileInfo.agentView = {
          type: "text",
          content: tool.content,
        };

        return;

      case "get-file-binary":
        fileInfo.agentView = {
          type: "binary",
          mtime: tool.mtime,
        };
        return;

      case "insert":
      case "replace": {
        if (fileInfo.fileTypeInfo.category !== FileCategory.TEXT) {
          throw new Error(
            `Cannot perform ${tool.type} operation on non-text file ${absFilePath} (file type: ${fileInfo.fileTypeInfo.category})`,
          );
        }

        if (fileInfo.agentView && fileInfo.agentView.type !== "text") {
          throw new Error(
            `Cannot perform ${tool.type} operation on ${absFilePath}: agent view type is ${fileInfo.agentView.type}, expected text`,
          );
        }

        // If we don't have the agent's view of the file yet, we need to read the current file content
        // This may happen if the agent performs the edit based on a text snippet the user sent without adding the
        // file to the context
        if (fileInfo.agentView) {
          const result =
            tool.type === "insert"
              ? applyInsert(
                  fileInfo.agentView.content,
                  tool.insertAfter,
                  tool.content,
                )
              : applyReplace(
                  fileInfo.agentView.content,
                  tool.find,
                  tool.replace,
                );

          if (result.status === "ok") {
            fileInfo.agentView = {
              type: "text",
              content: result.content,
            };
          } else {
            throw new Error(
              `Failed to update agent's view of ${absFilePath}: ${result.error}`,
            );
          }
        } else {
          // Read the current file content from disk
          try {
            const currentContent = fs.readFileSync(absFilePath, "utf8");
            fileInfo.agentView = {
              type: "text",
              content: currentContent,
            };
          } catch (err) {
            throw new Error(
              `Failed to read file ${absFilePath} to update agent's view: ${(err as Error).message}`,
            );
          }
        }
        return;
      }
      default:
        assertUnreachable(tool);
    }
  }

  /** we're about to send a user message to the agent. Find any changes that have happened to the files in context
   * that the agent doesn't know about yet, and update them.
   */
  async getContextUpdate(): Promise<FileUpdates> {
    if (this.isContextEmpty()) {
      return {};
    }

    const results: FileUpdates = {};
    await Promise.all(
      Object.keys(this.files).map(async (absFilePath) => {
        const result = await this.getFileMessageAndUpdateAgentViewOfFile({
          absFilePath: absFilePath as AbsFilePath,
        });
        if (result?.update) {
          results[absFilePath as AbsFilePath] = result;
        }
      }),
    );

    return results;
  }

  private async getFileMessageAndUpdateAgentViewOfFile({
    absFilePath,
  }: {
    absFilePath: AbsFilePath;
  }): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    const relFilePath = relativePath(this.context.cwd, absFilePath);
    const fileInfo = this.files[absFilePath];

    if (!fileInfo) {
      // File not in context, skip
      return undefined;
    }

    // Check if file exists first
    if (!fs.existsSync(absFilePath)) {
      // File has been deleted or moved, remove it from context
      delete this.files[absFilePath];

      return {
        absFilePath,
        relFilePath,
        update: {
          status: "ok",
          value: {
            type: "file-deleted",
          },
        },
      };
    }

    if (fileInfo.fileTypeInfo.category === FileCategory.TEXT) {
      return await this.handleTextFileUpdate(
        absFilePath,
        relFilePath,
        fileInfo,
      );
    } else {
      return await this.handleBinaryFileUpdate(
        absFilePath,
        relFilePath,
        fileInfo,
      );
    }
  }

  private async handleTextFileUpdate(
    absFilePath: AbsFilePath,
    relFilePath: RelFilePath,
    fileInfo: Files[AbsFilePath],
  ): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    let currentFileContent: string;
    // Handle text files (with potential buffer tracking)
    const bufSyncInfo = this.context.bufferTracker.getSyncInfo(absFilePath);

    if (bufSyncInfo) {
      // This file is open in a buffer
      try {
        const fileStats = fs.statSync(absFilePath);
        const diskMtime = fileStats.mtime.getTime();

        const buffer = new NvimBuffer(bufSyncInfo.bufnr, this.context.nvim);
        const currentChangeTick = await buffer.getChangeTick();

        const bufferChanged = bufSyncInfo.changeTick !== currentChangeTick;
        const fileChanged = bufSyncInfo.mtime < diskMtime;

        if (bufferChanged && fileChanged) {
          // Both buffer and file on disk have changed - conflict situation
          return {
            absFilePath,
            relFilePath,
            update: {
              status: "error",
              error: `Both the buffer ${bufSyncInfo.bufnr} and the file on disk for ${absFilePath} have changed. Cannot determine which version to use.`,
            },
          };
        }

        if (fileChanged && !bufferChanged) {
          await buffer.attemptEdit();
        }

        // now the buffer should have the latest version of the file
        const lines = await buffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        currentFileContent = lines.join("\n");
      } catch (err) {
        return {
          absFilePath,
          relFilePath,
          update: {
            status: "error",
            error: `Error when trying to grab the context of the file ${absFilePath}: ${(err as Error).message}\n${(err as Error).stack}`,
          },
        };
      }
    } else {
      // This file is only on disk. We need to read the latest version of it and send the diff along to the agent
      try {
        currentFileContent = fs.readFileSync(absFilePath).toString();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // File has been deleted or moved, remove it from context
          delete this.files[absFilePath];
          return {
            absFilePath,
            relFilePath,
            update: {
              status: "ok",
              value: {
                type: "file-deleted",
              },
            },
          };
        }
        throw err;
      }
    }

    // For text files, track the agent's view and generate diffs
    const prevContent =
      fileInfo.agentView?.type === "text"
        ? fileInfo.agentView.content
        : undefined;

    fileInfo.agentView = {
      type: "text",
      content: currentFileContent,
    };

    if (!prevContent) {
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "ok",
          value: {
            type: "whole-file",
            content: currentFileContent,
          },
        },
      };
    }

    if (prevContent === currentFileContent) {
      return undefined;
    }

    const patch = diff.createPatch(
      relFilePath,
      prevContent,
      currentFileContent,
      "previous",
      "current",
      {
        context: 2,
        ignoreNewlineAtEof: true,
      },
    ) as Patch;

    return {
      absFilePath,
      relFilePath,
      update: {
        status: "ok",
        value: { type: "diff", patch },
      },
    };
  }

  private async handleBinaryFileUpdate(
    absFilePath: AbsFilePath,
    relFilePath: RelFilePath,
    fileInfo: Files[AbsFilePath],
  ): Promise<FileUpdates[keyof FileUpdates] | undefined> {
    // Handle binary files (images/PDFs) - always read from disk, no buffer tracking
    try {
      const stats = fs.statSync(absFilePath);
      const currentMtime = stats.mtime.getTime();

      const prevMtime =
        fileInfo.agentView?.type === "binary"
          ? fileInfo.agentView.mtime
          : undefined;

      // Update agent's view with current mtime
      fileInfo.agentView = {
        type: "binary",
        mtime: currentMtime,
      };

      // Only send update if file has changed or agent hasn't seen it before
      if (prevMtime && prevMtime >= currentMtime) {
        // File hasn't changed, no update needed
        return undefined;
      } else {
        if (fileInfo.fileTypeInfo.category === FileCategory.PDF) {
          // Extract text from PDF
          const pdfTextResult = await extractPdfText(absFilePath);
          if (pdfTextResult.status === "error") {
            return {
              absFilePath,
              relFilePath,
              update: {
                status: "error",
                error: pdfTextResult.error,
              },
            };
          }

          return {
            absFilePath,
            relFilePath,
            update: {
              status: "ok",
              value: {
                type: "whole-file",
                content: pdfTextResult.value,
              },
            },
          };
        } else {
          // Handle other binary files (images) with base64
          const buffer = fs.readFileSync(absFilePath);
          return {
            absFilePath,
            relFilePath,
            update: {
              status: "ok",
              value: {
                type: "whole-file",
                content: buffer.toString("base64"),
              },
            },
          };
        }
      }
    } catch (err) {
      return {
        absFilePath,
        relFilePath,
        update: {
          status: "error",
          error: `Error checking file stats for ${absFilePath}: ${(err as Error).message}`,
        },
      };
    }
  }

  private static async loadAutoContext(
    nvim: Nvim,
    options: MagentaOptions,
  ): Promise<Files> {
    const files: Files = {};

    if (!options.autoContext || options.autoContext.length === 0) {
      return files;
    }

    try {
      const cwd = await getcwd(nvim);

      // Find all files matching the glob patterns
      const matchedFiles = await this.findFilesCrossPlatform(
        options.autoContext,
        cwd,
        nvim,
      );

      const filteredFiles = await this.filterSupportedFiles(matchedFiles, nvim);

      // Convert to the expected format
      for (const matchInfo of filteredFiles) {
        files[matchInfo.absFilePath] = {
          relFilePath: matchInfo.relFilePath,
          fileTypeInfo: matchInfo.fileTypeInfo,
          agentView: undefined,
        };
      }
    } catch (err) {
      nvim.logger.error(
        `Error loading auto context: ${(err as Error).message}`,
      );
    }

    return files;
  }

  private static async findFilesCrossPlatform(
    globPatterns: string[],
    cwd: NvimCwd,
    nvim: Nvim,
  ): Promise<Array<{ absFilePath: AbsFilePath; relFilePath: RelFilePath }>> {
    const allMatchedPaths: Array<{
      absFilePath: AbsFilePath;
      relFilePath: RelFilePath;
    }> = [];

    await Promise.all(
      globPatterns.map(async (pattern) => {
        try {
          // Use nocase: true for cross-platform case-insensitivity
          const matches = await glob(pattern, {
            cwd,
            nocase: true,
            nodir: true,
          });

          for (const match of matches) {
            const absFilePath = resolveFilePath(
              cwd,
              match as UnresolvedFilePath,
            );
            if (fs.existsSync(absFilePath)) {
              allMatchedPaths.push({
                absFilePath,
                relFilePath: relativePath(cwd, absFilePath),
              });
            }
          }
        } catch (err) {
          nvim.logger.error(
            `Error processing glob pattern "${pattern}": ${(err as Error).message}`,
          );
        }
      }),
    );

    const uniqueFiles = new Map<
      string,
      { absFilePath: AbsFilePath; relFilePath: RelFilePath }
    >();

    for (const fileInfo of allMatchedPaths) {
      try {
        // Get canonical path to handle symlinks and case differences
        const canonicalPath = fs.realpathSync(fileInfo.absFilePath);
        // Use normalized path as the deduplication key
        const normalizedPath = path.normalize(canonicalPath);

        if (!uniqueFiles.has(normalizedPath)) {
          uniqueFiles.set(normalizedPath, fileInfo);
        }
      } catch {
        // Fallback if realpathSync fails
        const normalizedPath = path.normalize(fileInfo.absFilePath);
        if (!uniqueFiles.has(normalizedPath)) {
          uniqueFiles.set(normalizedPath, fileInfo);
        }
      }
    }

    return Array.from(uniqueFiles.values());
  }

  private static async filterSupportedFiles(
    matchedFiles: Array<{ absFilePath: AbsFilePath; relFilePath: RelFilePath }>,
    nvim: Nvim,
  ): Promise<
    Array<{
      absFilePath: AbsFilePath;
      relFilePath: RelFilePath;
      fileTypeInfo: FileTypeInfo;
    }>
  > {
    const supportedFiles: Array<{
      absFilePath: AbsFilePath;
      relFilePath: RelFilePath;
      fileTypeInfo: FileTypeInfo;
    }> = [];

    await Promise.all(
      matchedFiles.map(async (fileInfo) => {
        try {
          const fileTypeInfo = await detectFileType(fileInfo.absFilePath);
          if (!fileTypeInfo) {
            nvim.logger.error(`File ${fileInfo.relFilePath} does not exist.`);
            return;
          }
          if (fileTypeInfo.category !== FileCategory.UNSUPPORTED) {
            supportedFiles.push({ ...fileInfo, fileTypeInfo });
          } else {
            // Log informational message about skipped unsupported files
            nvim.logger.warn(
              `Skipping ${fileInfo.relFilePath} from auto-context: ${fileTypeInfo.category} files are not supported in context (detected MIME type: ${fileTypeInfo.mimeType})`,
            );
          }
        } catch (error) {
          nvim.logger.error(
            `Failed to detect file type for ${fileInfo.relFilePath} during auto-context loading: ${(error as Error).message}`,
          );
        }
      }),
    );

    return supportedFiles;
  }

  /** renders a summary of all the files we're tracking, with the ability to delete or navigate to each file.
   */
  view() {
    const fileContext = [];
    if (Object.keys(this.files).length == 0) {
      return "";
    }

    for (const absFilePath in this.files) {
      const fileInfo = this.files[absFilePath as AbsFilePath];
      fileContext.push(
        withBindings(d`- ${withInlineCode(d`\`${fileInfo.relFilePath}\``)}\n`, {
          dd: () =>
            this.myDispatch({
              type: "remove-file-context",
              absFilePath: absFilePath as AbsFilePath,
            }),
          "<CR>": () =>
            this.myDispatch({
              type: "open-file",
              absFilePath: absFilePath as AbsFilePath,
            }),
        }),
      );
    }

    return d`\
${withExtmark(d`# context:`, { hl_group: "@markup.heading.1.markdown" })}
${fileContext}`;
  }

  renderContextUpdate(contextUpdates: FileUpdates | undefined) {
    if (!(contextUpdates && Object.keys(contextUpdates).length)) {
      return "";
    }

    const fileUpdates = [];
    for (const path in contextUpdates) {
      const absFilePath = path as AbsFilePath;
      const update = contextUpdates[absFilePath];

      if (update.update.status === "ok") {
        let changeIndicator = "";
        switch (update.update.value.type) {
          case "diff": {
            // Count additions and deletions in the patch
            const patch = update.update.value.patch;
            const additions = (patch.match(/^\+[^+]/gm) || []).length;
            const deletions = (patch.match(/^-[^-]/gm) || []).length;
            changeIndicator = `[ +${additions} / -${deletions} ]`;
            break;
          }
          case "whole-file": {
            // Count lines in the whole file content
            const lineCount =
              (update.update.value.content.match(/\n/g) || []).length + 1;
            changeIndicator = `[ +${lineCount} ]`;
            break;
          }
          case "file-deleted": {
            changeIndicator = "[ deleted ]";
            break;
          }
          default:
            assertUnreachable(update.update.value);
        }

        const filePathLink = withBindings(d`- \`${update.relFilePath}\``, {
          "<CR>": () =>
            this.myDispatch({
              type: "open-file",
              absFilePath,
            }),
        });

        fileUpdates.push(d`${filePathLink} ${changeIndicator}\n`);
      } else {
        fileUpdates.push(
          d`- \`${absFilePath}\` [Error: ${update.update.error}]\n`,
        );
      }
    }

    return fileUpdates.length > 0 ? d`Context Updates:\n${fileUpdates}\n` : "";
  }

  contextUpdatesToContent(
    contextUpdates: FileUpdates,
  ): ProviderMessageContent[] {
    const content: ProviderMessageContent[] = [];
    const textUpdates: string[] = [];

    for (const path in contextUpdates) {
      const absFilePath = path as AbsFilePath;
      const update = contextUpdates[absFilePath];
      const fileInfo = this.files[absFilePath];

      if (update.update.status === "ok") {
        switch (update.update.value.type) {
          case "whole-file": {
            if (fileInfo?.fileTypeInfo.category === FileCategory.TEXT) {
              // Text file - include in text updates
              textUpdates.push(`\
- \`${update.relFilePath}\`
\`\`\`
${update.update.value.content}
\`\`\``);
            } else if (fileInfo?.fileTypeInfo.category === FileCategory.PDF) {
              // PDF file - content is extracted text
              textUpdates.push(`\
- \`${update.relFilePath}\`
\`\`\`
${update.update.value.content}
\`\`\``);
            } else if (fileInfo?.fileTypeInfo.category === FileCategory.IMAGE) {
              // Image file - add as separate image content
              content.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: fileInfo.fileTypeInfo.mimeType as
                    | "image/jpeg"
                    | "image/png"
                    | "image/gif"
                    | "image/webp",
                  data: update.update.value.content,
                },
              });
              textUpdates.push(`\
- \`${update.relFilePath}\`
Image file updated (see attached image).`);
            } else {
              // Fallback for unknown file types
              textUpdates.push(`\
- \`${update.relFilePath}\`
File content updated.`);
            }
            break;
          }
          case "diff": {
            textUpdates.push(
              `\
- \`${update.relFilePath}\`
\`\`\`diff
${update.update.value.patch}
\`\`\``,
            );
            break;
          }
          case "file-deleted": {
            textUpdates.push(`\
- \`${update.relFilePath}\`
This file has been deleted and removed from context.`);
            break;
          }
          default:
            assertUnreachable(update.update.value);
        }
      } else {
        textUpdates.push(`\
- \`${update.relFilePath}\`
Error fetching update: ${update.update.error}`);
      }
    }

    // Add text content first
    if (textUpdates.length > 0) {
      content.unshift({
        type: "text",
        text: `\
These files are part of your context. This is the latest information about the content of each file.
From now on, whenever any of these files are updated by the user, you will get a message letting you know.
${textUpdates.join("\n")}`,
      });
    }

    return content;
  }
}
