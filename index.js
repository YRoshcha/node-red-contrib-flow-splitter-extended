const path = require('path')
const fs = require('fs')
const manager = require('flows-file-manager')
const eol = require('eol')
const yaml = require('js-yaml')
const functionsTemplatesHandler = require('./functions-templates-handler')

/**
 * Here we define some types to allow the IDE to provide us autocompletion.
 * Some are documented directly by the nodered team but some are not.
 * 
 * That's why we also made an `index.d.ts` for undocumented types we need to manipulate.
 * Those are defined by analysing the nodered code and some logging of those objects.
 * In this regard, the types defined by ourselves might be incomplete.
 * 
 * @typedef {import('./index').noderedEvent.FlowStartedEvent} FlowStartedEventType
 * @typedef {import('./index').noderedEvent.ExtendedNodeDef} ExtendedNodeDef
 * @typedef {import("node-red").NodeRedApp} REDType
 */

/**
 * Exposing the RED runtime globally to avoid passing it in every functions.
 * @type {REDType}
 */
let RED

const splitCfgFilename = '.config.flow-splitter.json'
const artifactsDirname = 'artifact'
const artifactsFilename = 'flows.json'
const DEFAULT_CFG = {
    fileFormat: 'yaml',
    destinationFolder: 'src',
    tabsOrder: [],
    monolithFilename: "flows.json",
    extractFunctionsTemplates: true,
    restoreFunctionsTemplates: false,
    enableArtifact: false
}

/**
 * Write splitter configuration to disk
 * @param {object} cfg - Splitter configuration
 * @param {string} projectPath - Path to the project
 */
function writeSplitterConfig(cfg, projectPath) {
    RED.log.info("[node-red-contrib-flow-splitter-extended] Writing new config")
    try {
        const splitterCfgToWrite = JSON.parse(JSON.stringify(cfg))
        delete splitterCfgToWrite.monolithFilename
        fs.writeFileSync(path.join(projectPath, splitCfgFilename), eol.auto(JSON.stringify(splitterCfgToWrite, null, 2)))
    } catch (error) {
        RED.log.warn(`[node-red-contrib-flow-splitter-extended] Could not write splitter config '${splitCfgFilename}': ${error}`)
    }
}

/**
 * Get the project path (handles both project mode and non-project mode)
 * @returns {string} Project path
 */
function getProjectPath() {
    const userDir = RED.settings.userDir
    const projectsConfigFile = path.join(userDir, '.config.projects.json')

    if (fs.existsSync(projectsConfigFile)) {
        const nrProjectsCfg = JSON.parse(fs.readFileSync(projectsConfigFile))
        return path.join(userDir, 'projects', nrProjectsCfg.activeProject)
    }
    return userDir
}

/**
 * Load splitter configuration from disk
 * @param {string} projectPath - Path to the project
 * @returns {object} Splitter configuration
 */
function loadSplitterConfig(projectPath) {
    let cfg = { ...DEFAULT_CFG }
    cfg.monolithFilename = RED.settings.flowFile || 'flows.json'
    
    const configPath = path.join(projectPath, splitCfgFilename)
    if (fs.existsSync(configPath)) {
        const loadedCfg = JSON.parse(fs.readFileSync(configPath))
        cfg = { ...cfg, ...loadedCfg }
        cfg.monolithFilename = loadedCfg.monolithFilename || RED.settings.flowFile || 'flows.json'
    }
    return cfg
}

/**
 * Get private RED instance to access internal APIs
 * @returns {REDType} Private RED instance
 */
function getPrivateRED() {
    for (const child of require.main.children) {
        if (child.filename.endsWith('red.js')) {
            return require(child.filename)
        }
    }
    return require('node-red')
}

/**
 * Extract functions and templates from split flow files
 * @param {object} cfg - Splitter configuration
 * @param {string} projectPath - Path to the project
 */
function extractFunctionsTemplatesFromSplitFiles(cfg, projectPath) {
    if (cfg.extractFunctionsTemplates === false) {
        return
    }

    const srcDir = path.join(projectPath, cfg.destinationFolder || 'src')
    const tabsDir = path.join(srcDir, 'tabs')
    const subflowsDir = path.join(srcDir, 'subflows')

    RED.log.info("[node-red-contrib-flow-splitter-extended] Extracting functions and templates...")

    processFlowDirectory(tabsDir, cfg.fileFormat, 'tab')
    processFlowDirectory(subflowsDir, cfg.fileFormat, 'subflow')
    
    // Clean up orphaned directories from renamed/deleted flows
    cleanupOrphanedDirectories(tabsDir, cfg.fileFormat)
    cleanupOrphanedDirectories(subflowsDir, cfg.fileFormat)
}

/**
 * Remove subdirectories that don't have a corresponding flow file
 * @param {string} dir - Directory to clean (tabs or subflows)
 * @param {string} fileFormat - File format (yaml or json)
 */
function cleanupOrphanedDirectories(dir, fileFormat) {
    if (!fs.existsSync(dir)) {
        return
    }

    const extension = fileFormat === 'yaml' ? '.yaml' : '.json'
    
    // Get all flow files
    const flowFiles = fs.readdirSync(dir)
        .filter(f => f.endsWith(extension))
        .map(f => path.basename(f, extension))
    
    // Get all subdirectories
    const subdirs = fs.readdirSync(dir)
        .filter(f => {
            const fullPath = path.join(dir, f)
            return fs.statSync(fullPath).isDirectory()
        })
    
    // Remove orphaned subdirectories
    subdirs.forEach(subdir => {
        if (!flowFiles.includes(subdir)) {
            const subdirPath = path.join(dir, subdir)
            try {
                fs.rmSync(subdirPath, { recursive: true, force: true })
                RED.log.info(`[node-red-contrib-flow-splitter-extended] Removed orphaned directory: ${subdir}`)
            } catch (error) {
                RED.log.warn(`[node-red-contrib-flow-splitter-extended] Could not remove orphaned directory ${subdir}: ${error.message}`)
            }
        }
    })
}

/**
 * Ensure every tab/subflow/config-node has a non-empty label (tabs) or name
 * (everything else) before handing the flows off to flows-file-manager.
 *
 * Works around a bug in flows-file-manager's disambiguate() function: it
 * unconditionally reads `subelement.config.site.name` as part of its
 * fallback chain (`config[attribute] || subelement[attribute] || subelement.config.site.name || ...`).
 * When a node has no label/name AND no config.site property (the normal case
 * for most nodes), that access throws "Cannot read properties of undefined
 * (reading 'name')" and crashes the flow reload. Guaranteeing a truthy
 * label/name here means the first operand of that chain always short-circuits
 * before the buggy access is ever reached.
 * @param {Array} flowNodes - Array of all flow nodes from Node-RED
 * @returns {Array} flowNodes - Same array, mutated in place with guaranteed identifiers
 */
function ensureFlowIdentifiers(flowNodes) {
    flowNodes.forEach(node => {
        if (node.type === 'tab') {
            if (!node.label) {
                node.label = node.name || node.type || node.id
            }
        } else if (!node.name) {
            node.name = node.type || node.id
        }
    })
    return flowNodes
}

/**
 * Clean up old flow files when a tab or subflow has been renamed.
 * Scans existing files and removes those with IDs that match current flows but have different filenames.
 * @param {Array} flowNodes - Array of all flow nodes from Node-RED
 * @param {object} cfg - Splitter configuration
 * @param {string} projectPath - Path to the project
 */
function cleanupRenamedFlows(flowNodes, cfg, projectPath) {
    const srcDir = path.join(projectPath, cfg.destinationFolder || 'src')
    const tabsDir = path.join(srcDir, 'tabs')
    const subflowsDir = path.join(srcDir, 'subflows')
    const extension = cfg.fileFormat === 'yaml' ? '.yaml' : '.json'

    // Build maps of ID -> expected filename from the current flow nodes
    const tabsIdToFilename = new Map()
    const subflowsIdToFilename = new Map()

    flowNodes.forEach(node => {
        if (node.type === 'tab' && node.id) {
            // Use normalizedLabel if available, otherwise compute from label
            const label = node.label || node.id
            const expectedFilename = node.normalizedLabel || 
                label.replace(/[\/\\:*?"<>|]/g, '-').toLowerCase().replace(/\s+/g, '-')
            tabsIdToFilename.set(node.id, expectedFilename)
        } else if (node.type === 'subflow' && node.id) {
            const name = node.name || node.id
            const expectedFilename = name.replace(/[\/\\:*?"<>|]/g, '-').toLowerCase().replace(/\s+/g, '-')
            subflowsIdToFilename.set(node.id, expectedFilename)
        }
    })

    // Clean up tabs directory
    cleanupRenamedFlowsInDir(tabsDir, tabsIdToFilename, extension, 'tab')
    
    // Clean up subflows directory
    cleanupRenamedFlowsInDir(subflowsDir, subflowsIdToFilename, extension, 'subflow')
}

/**
 * Clean up renamed flows in a specific directory.
 * Removes old files when the same ID exists but with a different filename.
 * @param {string} dir - Directory to scan
 * @param {Map} idToFilename - Map of ID to expected filename
 * @param {string} extension - File extension (.yaml or .json)
 * @param {string} flowType - Type of flow (tab or subflow)
 */
function cleanupRenamedFlowsInDir(dir, idToFilename, extension, flowType) {
    if (!fs.existsSync(dir)) {
        return
    }

    const files = fs.readdirSync(dir).filter(f => f.endsWith(extension))

    files.forEach(file => {
        const filePath = path.join(dir, file)
        const filename = path.basename(file, extension)

        try {
            let flowData
            const fileContent = fs.readFileSync(filePath, 'utf8')

            if (extension === '.yaml') {
                flowData = yaml.load(fileContent)
            } else {
                flowData = JSON.parse(fileContent)
            }

            const flowDataArray = Array.isArray(flowData) ? flowData : [flowData]
            const flowNode = flowDataArray.find(n => n.type === flowType)

            if (flowNode && flowNode.id) {
                const expectedFilename = idToFilename.get(flowNode.id)
                
                // If this ID exists in current flows but with a different filename, this is an old renamed file
                if (expectedFilename && expectedFilename !== filename) {
                    RED.log.info(`[node-red-contrib-flow-splitter-extended] Removing old ${flowType} file "${file}" (renamed to "${expectedFilename}${extension}")`)
                    
                    // Remove the old flow file
                    fs.unlinkSync(filePath)
                    
                    // Remove the corresponding subdirectory if it exists
                    const subdirPath = path.join(dir, filename)
                    if (fs.existsSync(subdirPath) && fs.statSync(subdirPath).isDirectory()) {
                        fs.rmSync(subdirPath, { recursive: true, force: true })
                        RED.log.info(`[node-red-contrib-flow-splitter-extended] Removed old ${flowType} directory "${filename}"`)
                    }
                }
            }
        } catch (error) {
            RED.log.warn(`[node-red-contrib-flow-splitter-extended] Error checking ${flowType} file ${file}: ${error.message}`)
        }
    })
}

/**
 * Process a directory of flow files to extract functions/templates
 * @param {string} dir - Directory to process
 * @param {string} fileFormat - File format (yaml or json)
 * @param {string} flowType - Type of flow (tab or subflow)
 */
function processFlowDirectory(dir, fileFormat, flowType) {
    if (!fs.existsSync(dir)) {
        return
    }

    const extension = fileFormat === 'yaml' ? '.yaml' : '.json'
    const files = fs.readdirSync(dir).filter(f => f.endsWith(extension))

    files.forEach(file => {
        const filePath = path.join(dir, file)
        const flowName = path.basename(file, extension)

        try {
            let flowData
            const fileContent = fs.readFileSync(filePath, 'utf8')

            if (fileFormat === 'yaml') {
                flowData = yaml.load(fileContent)
            } else {
                flowData = JSON.parse(fileContent)
            }

            const flowNodes = Array.isArray(flowData) ? flowData : [flowData]
            functionsTemplatesHandler.extractFunctionsAndTemplates(flowNodes, flowName, dir, RED)

        } catch (error) {
            RED.log.warn(`[node-red-contrib-flow-splitter-extended] Error processing ${flowType} ${flowName}: ${error.message}`)
        }
    })
}

/**
 * Restore functions and templates back into split flow files before rebuilding single flows.json file
 * @param {object} cfg - Splitter configuration
 * @param {string} projectPath - Path to the project
 */
function restoreFunctionsTemplatesIntoSplitFiles(cfg, projectPath) {
    if (cfg.restoreFunctionsTemplates === false) {
        return
    }

    const srcDir = path.join(projectPath, cfg.destinationFolder || 'src')
    const tabsDir = path.join(srcDir, 'tabs')
    const subflowsDir = path.join(srcDir, 'subflows')

    RED.log.info("[node-red-contrib-flow-splitter-extended] Restoring functions and templates...")

    restoreIntoFlowDirectory(tabsDir, cfg.fileFormat, 'tab')
    restoreIntoFlowDirectory(subflowsDir, cfg.fileFormat, 'subflow')
}

/**
 * Process a directory of flow files to restore functions/templates
 * @param {string} dir - Directory to process
 * @param {string} fileFormat - File format (yaml or json)
 * @param {string} flowType - Type of flow (tab or subflow)
 */
function restoreIntoFlowDirectory(dir, fileFormat, flowType) {
    if (!fs.existsSync(dir)) {
        return
    }

    const extension = fileFormat === 'yaml' ? '.yaml' : '.json'
    const files = fs.readdirSync(dir).filter(f => f.endsWith(extension))

    files.forEach(file => {
        const filePath = path.join(dir, file)
        const flowName = path.basename(file, extension)

        try {
            let flowData
            const fileContent = fs.readFileSync(filePath, 'utf8')

            if (fileFormat === 'yaml') {
                flowData = yaml.load(fileContent)
            } else {
                flowData = JSON.parse(fileContent)
            }

            let flowNodes = Array.isArray(flowData) ? flowData : [flowData]
            flowNodes = functionsTemplatesHandler.restoreFunctionsAndTemplates(flowNodes, flowName, dir, RED)

            if (fileFormat === 'yaml') {
                const yamlContent = yaml.dump(flowNodes, {
                    indent: 2,
                    lineWidth: -1,
                    noRefs: true,
                    sortKeys: false
                })
                fs.writeFileSync(filePath, eol.auto(yamlContent), 'utf8')
            } else {
                fs.writeFileSync(filePath, eol.auto(JSON.stringify(flowNodes, null, 2)), 'utf8')
            }

        } catch (error) {
            RED.log.warn(`[node-red-contrib-flow-splitter-extended] Error restoring ${flowType} ${flowName}: ${error.message}`)
        }
    })
}

/**
 * Write a monolith artifact file to artifact/flows.json when enabled.
 * @param {object} cfg - Splitter configuration
 * @param {string} projectPath - Path to the project
 * @param {Array} [flowNodes] - Optional flow nodes to serialize directly
 */
function writeMonolithArtifact(cfg, projectPath, flowNodes) {
    if (cfg.enableArtifact !== true) {
        return
    }

    const artifactDir = path.join(projectPath, artifactsDirname)
    const artifactPath = path.join(artifactDir, artifactsFilename)

    try {
        fs.mkdirSync(artifactDir, { recursive: true })

        if (Array.isArray(flowNodes)) {
            fs.writeFileSync(artifactPath, eol.auto(JSON.stringify(flowNodes, null, 2)), 'utf8')
        } else {
            const monolithPath = path.join(projectPath, cfg.monolithFilename || RED.settings.flowFile || 'flows.json')

            if (!fs.existsSync(monolithPath)) {
                RED.log.warn(`[node-red-contrib-flow-splitter-extended] Could not write artifact: monolith file not found at '${monolithPath}'`)
                return
            }

            fs.copyFileSync(monolithPath, artifactPath)
        }

        RED.log.info(`[node-red-contrib-flow-splitter-extended] Wrote monolith artifact at '${artifactPath}'`)
    } catch (error) {
        RED.log.warn(`[node-red-contrib-flow-splitter-extended] Could not write monolith artifact: ${error.message}`)
    }
}

/**
 * Manual reload endpoint handler
 * Restores functions/templates from files and reloads flows
 */
async function manualReload(req, res) {
    try {
        RED.log.info("[node-red-contrib-flow-splitter-extended] Manual reload triggered")

        const projectPath = getProjectPath()
        const cfg = loadSplitterConfig(projectPath)

        restoreFunctionsTemplatesIntoSplitFiles(cfg, projectPath)

        const flowSet = manager.constructFlowSetFromTreeFiles(cfg, projectPath)

        if (!flowSet) {
            RED.log.error("[node-red-contrib-flow-splitter-extended] Cannot build FlowSet from source tree files")
            return res.status(500).json({ 
                success: false, 
                error: "Cannot build FlowSet from source tree files" 
            })
        }

        manager.constructMonolithFileFromFlowSet(flowSet, cfg, projectPath, false)
        writeMonolithArtifact(cfg, projectPath)

        const PRIVATE_RED = getPrivateRED()
        await PRIVATE_RED.nodes.loadFlows(true)

        RED.log.info("[node-red-contrib-flow-splitter-extended] Manual reload completed successfully")
        
        res.json({ 
            success: true, 
            message: "Functions and templates reloaded successfully"
        })

    } catch (error) {
        RED.log.error(`[node-red-contrib-flow-splitter-extended] Manual reload failed: ${error.message}`)
        res.status(500).json({ 
            success: false, 
            error: error.message 
        })
    }
}

/**
 * Main function executed on each flow restart
 * @param {FlowStartedEventType} flowEventData
 * @returns {void}
 */
async function onFlowReload(flowEventData) {
    RED.log.info("[node-red-contrib-flow-splitter-extended] Flow restart event")

    const projectPath = getProjectPath()
    const cfg = loadSplitterConfig(projectPath)

    if (flowEventData.config.flows.length === 0) {
        // The flow file does not exist or is empty - rebuild from split files
        RED.log.info("[node-red-contrib-flow-splitter-extended] Rebuilding single flows.json file from source files")
        
        restoreFunctionsTemplatesIntoSplitFiles(cfg, projectPath)
        
        const flowSet = manager.constructFlowSetFromTreeFiles(cfg, projectPath)

        if (!flowSet) {
            RED.log.error("[node-red-contrib-flow-splitter-extended] Cannot build FlowSet from source tree files")
            return
        }

        const updatedCfg = manager.constructMonolithFileFromFlowSet(flowSet, cfg, projectPath, false)
        writeSplitterConfig(updatedCfg, projectPath)
        writeMonolithArtifact(updatedCfg, projectPath)

        const PRIVATE_RED = getPrivateRED()

        RED.log.info("[node-red-contrib-flow-splitter-extended] Stopping and loading nodes")

        PRIVATE_RED.nodes.loadFlows(true).then(function () {
            RED.log.info("[node-red-contrib-flow-splitter-extended] Flows are rebuilt and available")
        })
        return
    }

    // Flows exist - split into source files
    // First, clean up any old files from renamed tabs/subflows
    cleanupRenamedFlows(flowEventData.config.flows, cfg, projectPath)

    // Guarantee every node has a label/name to avoid a crash inside
    // flows-file-manager's disambiguate() (see ensureFlowIdentifiers doc above)
    ensureFlowIdentifiers(flowEventData.config.flows)

    let flowSet
    try {
        flowSet = manager.constructFlowSetFromMonolithObject(flowEventData.config.flows)
    } catch (error) {
        RED.log.error(`[node-red-contrib-flow-splitter-extended] Failed to build FlowSet from monolith object (flows-file-manager error): ${error.message}`)
        return
    }

    const updatedCfg = manager.constructTreeFilesFromFlowSet(flowSet, cfg, projectPath)
    writeSplitterConfig(updatedCfg, projectPath)
    writeMonolithArtifact(updatedCfg, projectPath, flowEventData.config.flows)

    extractFunctionsTemplatesFromSplitFiles(updatedCfg, projectPath)

    try {
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
        await delay(150) // Wait for Node-RED to create the flowFile before erasing it
        fs.unlinkSync(path.join(projectPath, RED.settings.flowFile))
    } catch (error) {
        RED.log.warn(`[node-red-contrib-flow-splitter-extended] Cannot erase file '${RED.settings.flowFile}': ${error.message}`)
    }
}

/**
 * @param {REDType} REDRuntime 
 */
module.exports = function (REDRuntime) {
    RED = REDRuntime

    // Register the plugin for Node-RED
    RED.plugins.registerPlugin("node-red-contrib-flow-splitter-extended", {
        type: "exotec-deploy-plugins",
        onadd: function () {
            RED.log.info("[node-red-contrib-flow-splitter-extended] Initialized plugin successfully")
        }
    })

    // Register HTTP endpoint for manual reload
    RED.httpAdmin.post("/flow-splitter/reload", manualReload)
    RED.log.info("[node-red-contrib-flow-splitter-extended] Manual reload endpoint registered at POST /flow-splitter/reload")

    // Code to launch on every restart of the flows = boot or deploy event
    RED.events.on('flows:started', onFlowReload)
}
