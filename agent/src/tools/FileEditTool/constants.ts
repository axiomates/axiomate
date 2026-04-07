// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .axiomate/ folder
export const AXIOMATE_FOLDER_PERMISSION_PATTERN = '/.axiomate/**'

// Permission pattern for granting session-level access to the global ~/.axiomate/ folder
export const GLOBAL_AXIOMATE_FOLDER_PERMISSION_PATTERN = '~/.axiomate/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
