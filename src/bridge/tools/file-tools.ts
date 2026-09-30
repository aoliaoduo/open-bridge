/**
 * Public file-tool façade.
 *
 * Keep this module path stable for the dispatcher and tests while the concrete
 * implementations stay split by responsibility.
 */
export { listDirectory, findFiles, searchFiles } from "./file-query-tools.js";
export { readFiles } from "./file-read-tools.js";
export { writeFile, editBlock } from "./file-edit-tools.js";
export {
  normalizeGuardPath,
  createDirectory,
  moveFile,
  copyFile,
  deleteFile,
  getFileInfo,
  applyPatchTool,
} from "./file-mutation-tools.js";
