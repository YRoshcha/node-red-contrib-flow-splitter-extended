const path = require('path')
const fs = require('fs')
const manager = require('flows-file-manager')
const eol = require('eol')
const yaml = require('js-yaml')
const crypto = require('crypto')
const functionsTemplatesHandler = require('./functions-templates-handler')
const { writeFileAtomic } = functionsTemplatesHandler

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
let lastExtractionFingerprint = null

const splitCfgFilename = '.config.flow-splitter.json'
const artifactsDirname = 'artifact'
const artifactsFilename = 'flows.json'
const DEFAULT_CFG = {
    fileFormat: 'json',
    destinationFolder: 'src',
    tabsOrder: [],
    monolithFilename: "flows.json",
    extractFunctionsTemplates: true,
    restoreFunctionsTemplates: false,
    enableArtifact: true,
    fastJsonSplit: true
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
        writeFileAtomic(path.join(projectPath, splitCfgFilename), eol.auto(JSON.stringify(splitterCfgToWrite, null, 2)))
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
    if (!userDir) {
        // RED.settings.userDir can be undefined if this handler runs on a
        // 'flows:started' event fired very early during Node-RED startup,
        // before runtime settings are fully resolved. Returning null here
        // lets the caller skip processing gracefully instead of crashing
        // with "TypeError [ERR_INVALID_ARG_TYPE]: The 'path' argument must
        // be of type string. Received undefined".
        return null
    }
    const projectsConfigFile = path.join(userDir, '.config.projects.json')

    if (fs.existsSync(projectsConfigFile)) {
        const nrProjectsCfg = JSON.parse(fs.readFileSync(projectsConfigFile))
        // nrProjectsCfg.activeProject can be missing/undefined when project
        // mode is not actually in use (e.g. an empty or stale
        // .config.projects.json). Passing undefined to path.join() throws
        // "TypeError [ERR_INVALID_ARG_TYPE]: The 'path' argument must be of
        // type string. Received undefined", so fall back to the plain
        // userDir in that case instead of crashing.
        if (nrProjectsCfg && nrProjectsCfg.activeProject) {
            return path.join(userDir, 'projects', nrProjectsCfg.activeProject)
        }
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
 * Plugins only get the public API, which cannot reload flows from disk, so this
 * relies on Node-RED internals and throws a clear error if they change.
 * @returns {REDType} Private RED instance
 */
function getPrivateRED() {
    let privateRED
    const child = require.main && require.main.children.find(child => child.filename.endsWith('red.js'))
    try {
        privateRED = child ? require(child.filename) : require('node-red')
    } catch (error) {
        throw new Error(`Cannot access the Node-RED runtime to reload flows: ${error.message}`)
    }
    if (typeof privateRED?.nodes?.loadFlows !== 'function') {
        throw new Error('Cannot reload flows: RED.nodes.loadFlows() is not available in this Node-RED version')
    }
    return privateRED
}

/**
 * flows-file-manager skips split files it cannot parse, so one corrupted file
 * would silently drop its tab from the rebuilt flows.json. Throw instead, so
 * the boot rebuild falls back to the artifact and manual reload reports it.
 * @param {object} cfg - Splitter configuration
 * @param {string} projectPath - Path to the project
 */
function assertSplitFilesParse(cfg, projectPath) {
    const srcDir = path.join(projectPath, cfg.destinationFolder || 'src')
    const extension = `.${cfg.fileFormat}`
    for (const folder of ['tabs', 'subflows', 'config-nodes']) {
        const dir = path.join(srcDir, folder)
        if (!fs.existsSync(dir)) continue
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith(extension))) {
            const fileContent = fs.readFileSync(path.join(dir, file), 'utf8')
            try {
                if (cfg.fileFormat.toLowerCase() !== 'json') {
                    yaml.load(fileContent)
                } else {
                    JSON.parse(fileContent)
                }
            } catch (error) {
                throw new Error(`Cannot parse split file '${folder}/${file}': ${error.message}`)
            }
        }
    }
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
}

/**
 * Return a stable fingerprint for the fields that are externalized. Changes
 * to wiring or node metadata do not require rewriting thousands of source
 * files, while edits to function/template content still invalidate it.
 */
function getExtractionFingerprint(flowNodes) {
    const hash = crypto.createHash('sha1')
    for (const node of flowNodes) {
        if (node.type !== 'function' && node.type !== 'ui-template' && node.type !== 'template' &&
            node.type !== 'tab' && node.type !== 'subflow') continue
        // Tab/subflow names and node.z decide the extraction directory
        hash.update(JSON.stringify([
            node.id, node.type, node.name, node.label, node.z,
            node.func, node.initialize, node.finalize,
            node.info, node.format, node.template
        ]))
    }
    return hash.digest('hex')
}

/**
 * Remove split files that are no longer generated (deleted or renamed
 * tabs/subflows/config nodes). Otherwise they are read back and resurrected
 * the next time flows.json is rebuilt from the source tree.
 * @param {string} dir - tabs, subflows or config-nodes directory
 * @param {Set<string>} keep - File names generated by the current split
 */
function removeStaleFiles(dir, keep) {
    for (const file of fs.readdirSync(dir)) {
        const filePath = path.join(dir, file)
        if (!keep.has(file) && fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath)
            RED.log.info(`[node-red-contrib-flow-splitter-extended] Removed stale file: ${file}`)
        }
    }
}

/**
 * flows-file-manager currently writes every generated source file on every
 * deploy. Generate into a private staging tree and promote only changed
 * files, so deploys do not churn the project's source tree.
 */
function constructTreeFilesIncrementally(flowSet, cfg, projectPath) {
    const stagingName = `.flow-splitter-stage-${process.pid}-${Date.now()}`
    const stagingCfg = { ...cfg, destinationFolder: stagingName }
    const stagingRoot = path.join(projectPath, stagingName)
    const sourceRoot = path.join(projectPath, cfg.destinationFolder)

    try {
        const stagedCfg = manager.constructTreeFilesFromFlowSet(flowSet, stagingCfg, projectPath)
        const updatedCfg = { ...stagedCfg, destinationFolder: cfg.destinationFolder }
        for (const folder of ['tabs', 'subflows', 'config-nodes']) {
            const fromDir = path.join(stagingRoot, folder)
            const toDir = path.join(sourceRoot, folder)
            if (!fs.existsSync(fromDir)) continue
            fs.mkdirSync(toDir, { recursive: true })
            const files = fs.readdirSync(fromDir)
            for (const file of files) {
                const from = path.join(fromDir, file)
                const to = path.join(toDir, file)
                if (!fs.existsSync(to) || fs.readFileSync(from).compare(fs.readFileSync(to)) !== 0) {
                    writeFileAtomic(to, fs.readFileSync(from))
                }
            }
            removeStaleFiles(toDir, new Set(files))
        }
        return updatedCfg
    } finally {
        fs.rmSync(stagingRoot, { recursive: true, force: true })
    }
}

/**
 * Remove subdirectories that don't have a corresponding flow file
 * @param {string} dir - Directory to clean (tabs or subflows)
 * @param {string} fileFormat - File format (yaml, yml or json), also the file extension
 */
function cleanupOrphanedDirectories(dir, fileFormat) {
    if (!fs.existsSync(dir)) {
        return
    }

    const extension = `.${fileFormat}`
    
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
 *
 * Only tabs, subflows and config nodes (no x/y, the rule used by
 * @node-red/flow-parser) are disambiguated, so regular nodes are left
 * untouched. The live Node-RED config is never mutated: placeholders go on
 * copies, otherwise they show up in the editor and end up in flows.json.
 * @param {Array} flowNodes - Array of all flow nodes from Node-RED
 * @returns {Array} Copy of flowNodes with guaranteed identifiers
 */
function ensureFlowIdentifiers(flowNodes) {
    return flowNodes.map(node => {
        if (node.type !== 'tab' && node.type !== 'subflow' && 'x' in node && 'y' in node) return node
        const attribute = node.type === 'tab' ? 'label' : 'name'
        return node[attribute] ? node : { ...node, [attribute]: node.type }
    })
}

/**
 * Keep flows-file-manager artifacts out of the split files: undo the
 * ensureFlowIdentifiers() placeholders on the parsed copies (flow-parser
 * deep-clones its input) and hide the normalizedLabel added by
 * disambiguate(). The tree writer still reads normalizedLabel for file
 * names, but flow-parser's export() only copies enumerable properties.
 * @param {object} flowSet - FlowSet built by constructFlowSetFromMonolithObject()
 * @param {Array} flowNodes - Original flow nodes from Node-RED
 */
function cleanFlowSet(flowSet, flowNodes) {
    const originals = new Map(flowNodes.map(node => [node.id, node]))
    for (const element of [...flowSet.flows.values(), ...flowSet.subflows.values(), ...flowSet.configNodes.values()]) {
        const original = originals.get(element.id)
        const attribute = element.type === 'tab' ? 'label' : 'name'
        if (original && !original[attribute]) {
            if (attribute in original) element.config[attribute] = original[attribute]
            else delete element.config[attribute]
        }
        Object.defineProperty(element.config, 'normalizedLabel', { enumerable: false })
    }
}

function fastNormalizeString(value) {
    let normalized = String(value || '').replace(/[^a-zA-Z0-9\.]/g, '-').replace(/----/g, '-').replace(/---/g, '-').replace(/--/g, '-').toLowerCase()
    return normalized.replace(/^-+|-+$/g, '')
}

function fastFileName(node, usedNames) {
    let fileName = fastNormalizeString(node.label || node.name || node.type || node.id)
    if (!fileName) fileName = node.id
    if (usedNames.has(fileName)) fileName = `${fileName}-${node.id}`
    usedNames.add(fileName)
    return fileName
}

function fastJsonTree(flowNodes, cfg, projectPath) {
    const srcDir = path.join(projectPath, cfg.destinationFolder || 'src')
    const groups = []
    const tabs = flowNodes.filter(node => node.type === 'tab')
    const subflows = flowNodes.filter(node => node.type === 'subflow')
    const usedNames = new Set()

    const addGroup = (folder, node, contents) => {
        const fileName = fastFileName(node, usedNames)
        groups.push({ folder, fileName, contents: [node].concat(contents.filter(item => item !== node).sort((a, b) => String(a.id).localeCompare(String(b.id)))) })
    }

    for (const tab of tabs) addGroup('tabs', tab, flowNodes.filter(node => node.z === tab.id))
    for (const subflow of subflows) addGroup('subflows', subflow, flowNodes.filter(node => node.z === subflow.id))

    const nestedIds = new Set(tabs.concat(subflows).map(node => node.id))
    for (const node of flowNodes) {
        if (!node.z && node.type !== 'tab' && node.type !== 'subflow' && !nestedIds.has(node.id)) {
            addGroup('config-nodes', node, [])
        }
    }

    for (const folder of ['tabs', 'subflows', 'config-nodes']) fs.mkdirSync(path.join(srcDir, folder), { recursive: true })
    for (const group of groups) {
        const filePath = path.join(srcDir, group.folder, `${group.fileName}.json`)
        // normalizedLabel comes from split files written by flows-file-manager
        const content = eol.auto(JSON.stringify(group.contents.map(({ normalizedLabel, ...node }) => node), null, 2))
        if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== content) writeFileAtomic(filePath, content)
    }
    for (const folder of ['tabs', 'subflows', 'config-nodes']) {
        removeStaleFiles(path.join(srcDir, folder), new Set(groups.filter(group => group.folder === folder).map(group => `${group.fileName}.json`)))
    }
    return { ...cfg, tabsOrder: tabs.map(tab => tab.id) }
}

function extractFunctionsTemplatesFromRawFlow(cfg, projectPath, flowNodes) {
    if (cfg.extractFunctionsTemplates === false) return
    const srcDir = path.join(projectPath, cfg.destinationFolder || 'src')
    const tabs = flowNodes.filter(node => node.type === 'tab')
    const subflows = flowNodes.filter(node => node.type === 'subflow')
    const usedNames = new Set()
    const flowName = node => fastFileName(node, usedNames)
    for (const tab of tabs) {
        const name = flowName(tab)
        functionsTemplatesHandler.extractFunctionsAndTemplates([tab].concat(flowNodes.filter(node => node.z === tab.id)), name, path.join(srcDir, 'tabs'), RED)
    }
    for (const subflow of subflows) {
        const name = flowName(subflow)
        functionsTemplatesHandler.extractFunctionsAndTemplates([subflow].concat(flowNodes.filter(node => node.z === subflow.id)), name, path.join(srcDir, 'subflows'), RED)
    }
}

/**
 * Process a directory of flow files to extract functions/templates
 * @param {string} dir - Directory to process
 * @param {string} fileFormat - File format (yaml, yml or json), also the file extension
 * @param {string} flowType - Type of flow (tab or subflow)
 */
function processFlowDirectory(dir, fileFormat, flowType) {
    if (!fs.existsSync(dir)) {
        return
    }

    const extension = `.${fileFormat}`
    const files = fs.readdirSync(dir).filter(f => f.endsWith(extension))

    files.forEach(file => {
        const filePath = path.join(dir, file)
        const flowName = path.basename(file, extension)

        try {
            let flowData
            const fileContent = fs.readFileSync(filePath, 'utf8')

            if (fileFormat.toLowerCase() !== 'json') {
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
 * @param {string} fileFormat - File format (yaml, yml or json), also the file extension
 * @param {string} flowType - Type of flow (tab or subflow)
 */
function restoreIntoFlowDirectory(dir, fileFormat, flowType) {
    if (!fs.existsSync(dir)) {
        return
    }

    const extension = `.${fileFormat}`
    const files = fs.readdirSync(dir).filter(f => f.endsWith(extension))

    files.forEach(file => {
        const filePath = path.join(dir, file)
        const flowName = path.basename(file, extension)

        try {
            let flowData
            const fileContent = fs.readFileSync(filePath, 'utf8')

            if (fileFormat.toLowerCase() !== 'json') {
                flowData = yaml.load(fileContent)
            } else {
                flowData = JSON.parse(fileContent)
            }

            let flowNodes = Array.isArray(flowData) ? flowData : [flowData]
            flowNodes = functionsTemplatesHandler.restoreFunctionsAndTemplates(flowNodes, flowName, dir, RED)

            if (fileFormat.toLowerCase() !== 'json') {
                const yamlContent = yaml.dump(flowNodes, {
                    indent: 2,
                    lineWidth: -1,
                    noRefs: true,
                    sortKeys: false
                })
                writeFileAtomic(filePath, eol.auto(yamlContent))
            } else {
                writeFileAtomic(filePath, eol.auto(JSON.stringify(flowNodes, null, 2)))
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
            writeFileAtomic(artifactPath, eol.auto(JSON.stringify(flowNodes, null, 2)))
        } else {
            const monolithPath = path.join(projectPath, cfg.monolithFilename || RED.settings.flowFile || 'flows.json')

            if (!fs.existsSync(monolithPath)) {
                RED.log.warn(`[node-red-contrib-flow-splitter-extended] Could not write artifact: monolith file not found at '${monolithPath}'`)
                return
            }

            writeFileAtomic(artifactPath, fs.readFileSync(monolithPath))
        }

        RED.log.info(`[node-red-contrib-flow-splitter-extended] Wrote monolith artifact at '${artifactPath}'`)
    } catch (error) {
        RED.log.warn(`[node-red-contrib-flow-splitter-extended] Could not write monolith artifact: ${error.message}`)
    }
}

/**
 * Restore flows.json from the artifact backup after a failed rebuild from
 * split source files. Only usable when `enableArtifact` is true and a
 * previous successful reload has left a backup on disk.
 * @param {object} cfg - Splitter configuration
 * @param {string} projectPath - Path to the project
 * @returns {boolean} true if the restore succeeded
 */
function restoreFromArtifactFallback(cfg, projectPath) {
    const artifactPath = path.join(projectPath, artifactsDirname, artifactsFilename)

    if (!fs.existsSync(artifactPath)) {
        RED.log.error(`[node-red-contrib-flow-splitter-extended] Rebuild from source files failed and no artifact backup exists at '${artifactPath}' - flows will remain empty. Enable 'enableArtifact' and let at least one successful reload run to create a backup.`)
        return false
    }

    try {
        const monolithPath = path.join(projectPath, cfg.monolithFilename || RED.settings.flowFile || 'flows.json')
        writeFileAtomic(monolithPath, fs.readFileSync(artifactPath))
        RED.log.warn(`[node-red-contrib-flow-splitter-extended] Rebuild from source files failed - restored flows from artifact backup '${artifactPath}' instead. Check 'src/' for corrupted split files.`)
        return true
    } catch (error) {
        RED.log.error(`[node-red-contrib-flow-splitter-extended] Rebuild failed AND could not restore from artifact backup: ${error.message}`)
        return false
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

        // The endpoint exists to apply external edits, so restore regardless
        // of restoreFunctionsTemplates (which only gates the boot rebuild)
        restoreFunctionsTemplatesIntoSplitFiles({ ...cfg, restoreFunctionsTemplates: true }, projectPath)
        assertSplitFilesParse(cfg, projectPath)

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
    if (!projectPath) {
        RED.log.warn("[node-red-contrib-flow-splitter-extended] RED.settings.userDir is not available yet, skipping flow-splitter processing for this event")
        return
    }
    const cfg = loadSplitterConfig(projectPath)

    if (flowEventData.config.flows.length === 0) {
        // The flow file does not exist or is empty - rebuild from split files
        RED.log.info("[node-red-contrib-flow-splitter-extended] Rebuilding single flows.json file from source files")

        let rebuildFailed = false
        let updatedCfg = cfg

        try {
            restoreFunctionsTemplatesIntoSplitFiles(cfg, projectPath)
            assertSplitFilesParse(cfg, projectPath)

            const flowSet = manager.constructFlowSetFromTreeFiles(cfg, projectPath)

            if (!flowSet) {
                RED.log.error("[node-red-contrib-flow-splitter-extended] Cannot build FlowSet from source tree files")
                rebuildFailed = true
            } else {
                updatedCfg = manager.constructMonolithFileFromFlowSet(flowSet, cfg, projectPath, false)
                writeSplitterConfig(updatedCfg, projectPath)
                writeMonolithArtifact(updatedCfg, projectPath)
            }
        } catch (error) {
            // Anything from a malformed YAML/JSON split file to a bug in
            // flows-file-manager itself can throw here. Treat it the same
            // as an explicit "cannot build" failure: fall back below rather
            // than letting Node-RED come up with zero flows silently.
            RED.log.error(`[node-red-contrib-flow-splitter-extended] Rebuild from source files threw an error: ${error.message}`)
            rebuildFailed = true
        }

        if (rebuildFailed) {
            if (cfg.enableArtifact !== true) {
                RED.log.error("[node-red-contrib-flow-splitter-extended] Rebuild failed and 'enableArtifact' is disabled, so there is no backup to fall back to. Flows will remain empty. Enable 'enableArtifact' in .config.flow-splitter.json to get automatic fallback next time.")
                return
            }
            if (!restoreFromArtifactFallback(cfg, projectPath)) {
                return
            }
        }

        RED.log.info("[node-red-contrib-flow-splitter-extended] Stopping and loading nodes")

        try {
            await getPrivateRED().nodes.loadFlows(true)
            RED.log.info(rebuildFailed
                ? "[node-red-contrib-flow-splitter-extended] Flows loaded from artifact fallback"
                : "[node-red-contrib-flow-splitter-extended] Flows are rebuilt and available")
        } catch (error) {
            RED.log.error(`[node-red-contrib-flow-splitter-extended] Could not load the rebuilt flows: ${error.message}. Restart Node-RED to load them.`)
        }
        return
    }

    // Flows exist - split into source files

    let updatedCfg
    if (cfg.fileFormat === 'json' && cfg.fastJsonSplit !== false) {
        updatedCfg = fastJsonTree(flowEventData.config.flows, cfg, projectPath)
    } else {
        let flowSet
        // Guarantee a label/name to avoid a crash inside flows-file-manager's
        // disambiguate() (see ensureFlowIdentifiers doc above)
        try {
            flowSet = manager.constructFlowSetFromMonolithObject(ensureFlowIdentifiers(flowEventData.config.flows))
        } catch (error) {
            RED.log.error(`[node-red-contrib-flow-splitter-extended] Failed to build FlowSet from monolith object (flows-file-manager error): ${error.message}`)
            return
        }
        cleanFlowSet(flowSet, flowEventData.config.flows)
        updatedCfg = constructTreeFilesIncrementally(flowSet, cfg, projectPath)
    }
    writeSplitterConfig(updatedCfg, projectPath)
    // Clean up extraction directories of renamed/deleted flows
    const srcDir = path.join(projectPath, cfg.destinationFolder || 'src')
    cleanupOrphanedDirectories(path.join(srcDir, 'tabs'), cfg.fileFormat)
    cleanupOrphanedDirectories(path.join(srcDir, 'subflows'), cfg.fileFormat)
    // Node-RED has already persisted the current monolith. Copying it is much
    // cheaper than JSON.stringify-ing the complete flow again.
    writeMonolithArtifact(updatedCfg, projectPath)

    const extractionFingerprint = getExtractionFingerprint(flowEventData.config.flows)
    if (extractionFingerprint !== lastExtractionFingerprint) {
        if (cfg.fileFormat === 'json' && cfg.fastJsonSplit !== false) {
            extractFunctionsTemplatesFromRawFlow(updatedCfg, projectPath, flowEventData.config.flows)
        } else {
            extractFunctionsTemplatesFromSplitFiles(updatedCfg, projectPath)
        }
        lastExtractionFingerprint = extractionFingerprint
    } else {
        RED.log.info("[node-red-contrib-flow-splitter-extended] Skipping unchanged function/template extraction")
    }

    // NOTE: earlier versions of this plugin deleted RED.settings.flowFile here
    // to force the "rebuild from src/" branch above on the next start. That
    // meant the monolith flows.json only ever existed transiently on disk -
    // if this plugin were ever removed (npm uninstall, or simply not carried
    // over into a new image), Node-RED would find no flowFile to boot from
    // and come up with zero flows, with no plugin left to rebuild it.
    //
    // We deliberately do NOT delete it anymore. Node-RED's own deploy/storage
    // layer already wrote a fully current flowFile to disk as part of this
    // same deploy - we simply leave it in place. This plugin's split files in
    // 'src/' remain the source you actually edit and diff in git (still add
    // the flowFile itself to .gitignore for that reason), but the flowFile on
    // disk is always a valid, current, plugin-independent fallback: if this
    // plugin is ever uninstalled, vanilla Node-RED keeps booting normally from
    // it, with zero data loss and zero code changes required.
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
