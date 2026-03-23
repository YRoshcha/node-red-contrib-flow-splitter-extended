# node-red-contrib-flow-splitter-extended

Node-RED plugin to split your **_flows.json_** file in individual YAML or JSON files (per tab, subflow and config-node) **with automatic extraction of function and ui-template node code**.

## Purpose

This plugin is useful if you regularly edit Node-RED applications in combination with editing in VS code or other IDEs.

It will make the diffs of your version control much more controlled and readable:  It will also allow to edit (complex) function and UI-template nodes from within an external IDE

- Commit files individually
- Nodes are ordered alphabetically with their id
- **Function and ui-template node code is extracted into separate `.js`, `.vue`, and `.md` files for easier editing in VS Code or other IDEs**
- **Edit function code externally and reload changes without restarting Node-RED**

**Note:** Add **_flows.json_** (or its equivalent given in the `package.json`) to your project `.gitignore` file.

## Features

### Flow Splitting
- Splits flows.json into separate files for tabs, subflows, and config-nodes
- Supports both YAML and JSON formats
- Maintains tab order through configuration

### Optional Function & Template Extraction and Restore (NEW)
- Automatically extracts into seperate files per function/ui-template
  - Extracts code from `function` nodes into `.js` files
  - Extracts `ui-template` (Dashboard 2.0) content into `.vue` files
  - Supports function `initialize` and `finalize` code in separate files
  - Extracts node `info` documentation into `.md` files
- Organizes extracted files in subdirectories alongside their parent tab/subflow
- Restores changes back to Node-RED
  - Automatically on startup
  - Manually reload using endpoint
- Both extraction (default true) and restoring (default false) can be changed in `.config.flow-splitter.json`


## Functioning

This plugin does not modify Node-RED core behavior. Node-RED core will still compile the flows into the JSON file stipulated in the `package.json`.

The code is executed at each start of the flows, i.e. a start of Node-RED or a "deploy" action.

It will take the running JSON file used by Node-RED specified in the Node-RED `package.json` (**_flows.json_** by default) and create all files in the directory `src` (_by default_) and their sub-directories : `tabs`, `subflows` and `config-nodes` at the root of the Node-RED userDir or the active project folder.

### Function/Template Extraction Workflow

When you deploy flows containing function or ui-template nodes:

1. **Extraction Phase**: After splitting the flow files, the plugin scans each tab and subflow for function and ui-template nodes
2. **File Creation**: For each node, it creates a subdirectory named after the tab/subflow and extracts:
   - Main code into `<node-name>.js` (function) or `<node-name>.vue` (ui-template)
   - Initialize code into `<node-name>.initialize.js` (if present)
   - Finalize code into `<node-name>.finalize.js` (if present)
   - Info documentation into `<node-name>.info.md` (if present)
3. **Manifest**: A `.manifest.json` file tracks the mapping between nodes and extracted files

When Node-RED starts with no flows.json:

1. **Collection Phase**: The plugin reads all extracted function/template files
2. **Update**: Updates the split flow files with the current code from disk
3. **Rebuild**: Reconstructs the flows.json from the updated split files

This allows you to edit function and template code in your favorite IDE with full syntax highlighting, linting, code assist and version control benefits!

### Manual Reload (Live Editing)

When Node-RED is running and you edit function/template files externally, use the **manual reload** endpoint to apply changes without restarting:

**HTTP Endpoint:**
```bash
POST http://localhost:1880/flow-splitter/reload
```

**Usage Examples:**
```powershell
# PowerShell (Windows)
Invoke-RestMethod -Uri http://localhost:1880/flow-splitter/reload -Method Post

# Bash (Linux/Mac)
curl -X POST http://localhost:1880/flow-splitter/reload

# From browser console or bookmarklet
fetch('http://localhost:1880/flow-splitter/reload', {method: 'POST'})
  .then(r => r.json()).then(console.log);
```

This allows you to:
1. Edit function/template files in VS Code or any other IDE
2. Save changes
3. Run the reload command
4. See changes immediately in Node-RED (without deploy/restart)

## File Structure Example

```
project/
├── flows.json (auto-deleted after split)
├── .config.flow-splitter.json
└── src/
    ├── tabs/
    │   ├── Dashboard.yaml
    │   └── Dashboard/
    │       ├── .manifest.json
    │       ├── process_data.js
    │       ├── process_data.initialize.js
    │       ├── process_data.finalize.js
    │       ├── process_data.info.md
    │       ├── header_template.vue
    │       └── status_widget.vue
    ├── subflows/
    │   ├── DataProcessor.yaml
    │   └── DataProcessor/
    │       ├── .manifest.json
    │       ├── transform.js
    │       └── validate.js
    └── config-nodes/
        └── mqtt-broker.yaml
```

## Configuration

The plugin will generate a configuration file `.config.flow-splitter.json` at the root of the Node-RED userDir or the active project folder.

Default configuration file =

```json
{
  "fileFormat": "yaml",
  "destinationFolder": "src",
  "tabsOrder": [],
  "extractFunctionsTemplates": true,
  "restoreFunctionsTemplates": false,
  "enableArtifact": false
}
```

You can freely edit the config file, the changes are taken into account at the next restart of the flows.

- `fileFormat`: parsing language for your split source files (either `yaml` or `json`)
- `destinationFolder`: path where to create the `tabs`, `subflows` and `config-nodes` sub-directories
- `tabsOrder`: position of each tab (ordered array of the Ids of each tab node)
- `extractFunctionsTemplates`: additional extraction of function and ui-template nodes
- `enableArtifact`: when `true`, writes a deployable monolith artifact to `artifact/flows.json` on reload/start events
## Installation

```bash
npm install node-red-contrib-flow-splitter-extended
```

Or install via the Node-RED palette manager.

## Quick Start

1. **Install the plugin** (see above)
2. **Start Node-RED** and deploy your flows
3. **Plugin automatically:**
   - Splits flows.json into separate files in `src/` directory
   - Extracts function and ui-template code into `.js` and `.vue` files
   - Creates `.config.flow-splitter.json` configuration file
4. **Edit extracted files** in VS Code or your favorite editor
5. **Reload changes** using the manual reload command (see above)

## Usage Workflows

### Option 1: Edit & Restart (Simple)
1. Edit function/template files in `src/tabs/<TabName>/`
2. Stop Node-RED
3. Start Node-RED
4. Changes are automatically collected and applied

### Option 2: Edit & Manual Reload (Fast)
1. Edit function/template files in `src/tabs/<TabName>/`
2. Save files
3. Run reload command: `curl -X POST http://localhost:1880/flow-splitter/reload`
4. Changes applied immediately (no restart needed)

## Working with Extracted Code

### Function Nodes

Function nodes are extracted to `.js` files:
- **Main code:** `<node-name>.js`
- **Initialize code:** `<node-name>.initialize.js` (if present)
- **Finalize code:** `<node-name>.finalize.js` (if present)
- **Documentation:** `<node-name>.info.md` (if present)

**Example:** A function node named "Process Data" creates:
```
src/tabs/MyTab/Process_Data.js
src/tabs/MyTab/Process_Data.initialize.js
src/tabs/MyTab/Process_Data.finalize.js
src/tabs/MyTab/Process_Data.info.md
```

### UI Template Nodes

Dashboard 2.0 ui-template nodes are extracted to `.vue` files:
- **Template code:** `<node-name>.vue`
- **Documentation:** `<node-name>.info.md` (if present)

**Example:** A ui-template node named "Header Widget" creates:
```
src/tabs/Dashboard/Header_Widget.vue
src/tabs/Dashboard/Header_Widget.info.md
```

## Benefits for Development

### Version Control
- Each function/template is in its own file - perfect for git diffs
- See exactly what changed in each function
- Review code changes more easily in pull requests

### IDE Integration
- Full syntax highlighting in VS Code or your favorite editor
- Linting and formatting support
- IntelliSense and autocomplete
- Search across all functions easily

### Code Organization
- Functions grouped by their parent tab/subflow
- Easy to find and navigate function code
- Consistent file structure across projects

## Troubleshooting

### Changes Not Appearing After Manual Reload

1. **Check Node-RED is running:** Ensure Node-RED is started and accessible at the URL
2. **Verify endpoint:** Test with `curl -X POST http://localhost:1880/flow-splitter/reload`
3. **Check file paths:** Ensure you're editing files in the correct `src/` subdirectory
4. **Review manifest:** Check `.manifest.json` to verify node-to-file mappings

### Files Not Extracted After Deploy

1. **Check configuration:** Ensure `extractFunctionsTemplates: true` in `.config.flow-splitter.json`
2. **Verify node types:** Only `function` and `ui-template` nodes are extracted
3. **Node naming:** Ensure nodes have names (unnamed nodes use their ID)

### Split Files Not Rebuilding

1. **Check flows.json:** Ensure flows.json doesn't exist (it should be deleted after split)
2. **Verify file format:** Ensure split files match the configured format (YAML/JSON)
3. **Restart Node-RED:** A full restart rebuilds flows.json from split files

## Compatibility

- Works with Node-RED project mode
- Compatible with function nodes (core)
- Compatible with Dashboard 2.0 ui-template nodes
- Supports both CommonJS and modern JavaScript

## Credits

This extended version combines the flow-splitting functionality from the original [node-red-contrib-flow-splitter](https://github.com/vgo-exo/node-red-contrib-flow-splitter) with function/template extraction inspired by [functions-templates-manager](https://github.com/daniel-payne/functions-templates-manager).

## License

See LICENSE file for details.




