const path = require('path')
const fs = require('fs-extra')

// Map of Cyrillic characters (Ukrainian + Russian) to Latin equivalents.
// Used to build filesystem/git-safe file names from node names that may
// contain Cyrillic text (git can fail with "pathspec ... did not match
// any files" on some setups when non-ASCII file names are involved).
const CYRILLIC_TO_LATIN = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'h', 'ґ': 'g', 'д': 'd', 'е': 'e', 'є': 'ie',
    'ж': 'zh', 'з': 'z', 'и': 'y', 'і': 'i', 'ї': 'yi', 'й': 'i', 'к': 'k', 'л': 'l',
    'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ь': '',
    'ю': 'iu', 'я': 'ia', 'ъ': '', 'ы': 'y', 'э': 'e', 'ё': 'e'
}

/**
 * Transliterate Cyrillic characters in a string to Latin equivalents and
 * strip any other non-ASCII characters, so the result is always safe to
 * use as a file name (including for git operations).
 * @param {string} text
 * @returns {string}
 */
function transliterate(text) {
    return text
        .split('')
        .map((char) => {
            const lower = char.toLowerCase()
            const mapped = CYRILLIC_TO_LATIN[lower]
            if (mapped === undefined) {
                return char
            }
            return char === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1)
        })
        .join('')
        .replace(/[^\x00-\x7F]/g, '')
}

/**
 * Maps a core `template` node's `format` field (its editor syntax-highlighting
 * mode) to a sensible file extension for the extracted file. Falls back to
 * `.txt` for formats not in this list (e.g. 'plain', or anything unexpected).
 */
const TEMPLATE_FORMAT_EXTENSIONS = {
    html: 'html',
    xml: 'xml',
    json: 'json',
    javascript: 'js',
    css: 'css',
    sql: 'sql',
    yaml: 'yaml',
    markdown: 'md',
    handlebars: 'hbs'
}

/**
 * @param {string} [format]
 * @returns {string} file extension without the leading dot
 */
function templateFileExtension(format) {
    return TEMPLATE_FORMAT_EXTENSIONS[format] || 'txt'
}

/**
 * Functions and Templates nodes Handler
 * Extracts function and ui-template node code into separate files
 * and restores them back when rebuilding flows
 */

/**
 * Extract functions and templates from flow nodes into separate files
 * @param {Array} flowNodes - Array of nodes from a tab or subflow
 * @param {string} flowName - Name of the tab or subflow
 * @param {string} flowDir - Directory where the flow file is stored
 * @param {object} RED - Node-RED runtime
 */
function extractFunctionsAndTemplates(flowNodes, flowName, flowDir, RED) {
    if (!flowNodes || flowNodes.length === 0) return

    const extractedDir = path.join(flowDir, flowName)
    
    // Delete entire extracted directory to ensure fresh state
    if (fs.existsSync(extractedDir)) {
        fs.removeSync(extractedDir)
    }
    
    const manifest = {}
    const fileNames = []
    let count = 0

    flowNodes.forEach((node) => {
        const id = node.id
        const type = node.type

        let name

        if (type === 'function') {
            name = node.name || 'unnamed-function'
        } else if (type === 'ui-template') {
            name = node.name || 'unnamed-template'
        } else if (type === 'template') {
            // Core Node-RED "template" node (mustache/plain templating).
            // Its content lives in `node.template`, not `node.format` -
            // `node.format` here is only the editor's syntax-highlighting
            // mode (e.g. "html", "json"), never actual code/content.
            name = node.name || 'unnamed-template-node'
        } else {
            return
        }

        const sanitizedName = transliterate(name).replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, '_')
        fileNames.push(sanitizedName)
        const nameCount = fileNames.filter((n) => n === sanitizedName).length

        let fileName
        if (nameCount > 1) {
            fileName = `${sanitizedName}(${nameCount})`
        } else {
            fileName = sanitizedName
        }

        // Detect the node kind so we read/write the right field:
        // - ui-template (Dashboard 2.0): code lives in `format`
        // - core template node: content lives in `template`
        // - function: code lives in `func` (+ optional initialize/finalize)
        const hasTemplateTag = node.format?.trim().indexOf('<template>') !== -1 ?? false
        const hasScriptTag = node.format?.trim().indexOf('<script>') !== -1 ?? false
        const isVue = type === 'ui-template' && typeof node.format === 'string' && (hasTemplateTag || hasScriptTag)
        const isTemplateNode = type === 'template'
        const isFun = (
            (typeof node.func === 'string' && node.func.trim().length > 0) ||
            (typeof node.initialize === 'string' && node.initialize.trim().length > 0) ||
            (typeof node.finalize === 'string' && node.finalize.trim().length > 0)
        ) && isVue === false && isTemplateNode === false

        let code
        if (isVue) {
            code = node.format
        } else if (isTemplateNode) {
            code = node.template
        } else {
            code = node.func
        }
        let initialize = isFun ? node.initialize : undefined
        let finalize = isFun ? node.finalize : undefined
        let info = node.info ?? undefined

        // Clean up empty values
        if ((code ?? '').trim().length === 0) code = undefined
        if ((initialize ?? '').trim().length === 0) initialize = undefined
        if ((finalize ?? '').trim().length === 0) finalize = undefined
        if ((info ?? '').trim().length === 0) info = undefined

        if (isVue || isFun || isTemplateNode) {
            // Ensure output directory exists
            if (!fs.existsSync(extractedDir)) {
                fs.mkdirSync(extractedDir, { recursive: true })
            }

            count++

            const baseName = fileName
            const codeExt = isVue ? 'vue' : (isTemplateNode ? templateFileExtension(node.format) : 'js')
            const codeName = `${baseName}.${codeExt}`
            const initializeName = `${baseName}.initialize.js`
            const finalizeName = `${baseName}.finalize.js`
            const infoName = `${baseName}.info.md`

            const codeFile = path.join(extractedDir, codeName)
            const initializeFile = path.join(extractedDir, initializeName)
            const finalizeFile = path.join(extractedDir, finalizeName)
            const infoFile = path.join(extractedDir, infoName)

            // Write files
            if (code != null) {
                fs.writeFileSync(codeFile, code, 'utf8')
            }
            if (initialize != null) {
                fs.writeFileSync(initializeFile, initialize, 'utf8')
            }
            if (finalize != null) {
                fs.writeFileSync(finalizeFile, finalize, 'utf8')
            }
            if (info != null) {
                fs.writeFileSync(infoFile, info, 'utf8')
            }

            // Store in manifest
            manifest[id] = {
                nodeId: id,
                name,
                sanitizedName,
                fileName,
                isVue,
                isFun,
                isTemplateNode,
                codeExt,
                hasCode: code != null,
                hasInitialize: initialize != null,
                hasFinalize: finalize != null,
                hasInfo: info != null
            }
        }
    })

    // Save manifest if we extracted anything
    if (count > 0) {
        const manifestFile = path.join(extractedDir, '.manifest.json')
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8')
        
        RED.log.info(`[node-red-contrib-flow-splitter] Extracted ${count} functions/templates for "${flowName}"`)
    }
}

/**
 * Restore functions and templates from separate files back into flow nodes
 * @param {Array} flowNodes - Array of nodes from a tab or subflow
 * @param {string} flowName - Name of the tab or subflow
 * @param {string} flowDir - Directory where the flow file is stored
 * @param {object} RED - Node-RED runtime
 * @returns {Array} - Updated flow nodes
 */
function restoreFunctionsAndTemplates(flowNodes, flowName, flowDir, RED) {
    if (!flowNodes || flowNodes.length === 0) return flowNodes

    const extractedDir = path.join(flowDir, flowName)
    const manifestFile = path.join(extractedDir, '.manifest.json')

    // Check if manifest exists
    if (!fs.existsSync(manifestFile)) {
        return flowNodes
    }

    let manifest
    try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    } catch (error) {
        RED.log.warn(`[node-red-contrib-flow-splitter] Could not read manifest for "${flowName}": ${error.message}`)
        return flowNodes
    }

    let updatedCount = 0

    // Update nodes with content from files
    Object.keys(manifest).forEach((nodeId) => {
        const item = manifest[nodeId]
        const node = flowNodes.find(n => n.id === nodeId)

        if (!node) {
            RED.log.warn(`[node-red-contrib-flow-splitter] Node ${nodeId} not found in flow "${flowName}"`)
            return
        }

        const baseName = item.fileName
        // item.codeExt may be absent in manifests written before this fix;
        // fall back to the old vue/js guess so existing manifests still work.
        const codeExt = item.codeExt || (item.isVue ? 'vue' : 'js')
        const codeName = `${baseName}.${codeExt}`
        const initializeName = `${baseName}.initialize.js`
        const finalizeName = `${baseName}.finalize.js`
        const infoName = `${baseName}.info.md`

        const codeFile = path.join(extractedDir, codeName)
        const initializeFile = path.join(extractedDir, initializeName)
        const finalizeFile = path.join(extractedDir, finalizeName)
        const infoFile = path.join(extractedDir, infoName)

        // Read and update code
        if (item.hasCode && fs.existsSync(codeFile)) {
            const content = fs.readFileSync(codeFile, 'utf8')
            if (item.isVue) {
                if (node.format !== content) {
                    node.format = content
                    updatedCount++
                }
            } else if (item.isTemplateNode) {
                if (node.template !== content) {
                    node.template = content
                    updatedCount++
                }
            } else if (item.isFun) {
                if (node.func !== content) {
                    node.func = content
                    updatedCount++
                }
            }
        }

        // Read and update initialize
        if (item.hasInitialize && fs.existsSync(initializeFile)) {
            const content = fs.readFileSync(initializeFile, 'utf8')
            if (node.initialize !== content) {
                node.initialize = content
                updatedCount++
            }
        }

        // Read and update finalize
        if (item.hasFinalize && fs.existsSync(finalizeFile)) {
            const content = fs.readFileSync(finalizeFile, 'utf8')
            if (node.finalize !== content) {
                node.finalize = content
                updatedCount++
            }
        }

        // Read and update info
        if (item.hasInfo && fs.existsSync(infoFile)) {
            const content = fs.readFileSync(infoFile, 'utf8')
            if (node.info !== content) {
                node.info = content
                updatedCount++
            }
        }
    })

    if (updatedCount > 0) {
        RED.log.info(`[node-red-contrib-flow-splitter] Restored ${updatedCount} functions/templates for "${flowName}"`)
    }

    return flowNodes
}

module.exports = {
    extractFunctionsAndTemplates,
    restoreFunctionsAndTemplates
}