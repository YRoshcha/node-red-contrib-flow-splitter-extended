const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const privateRED = require('./red')

const flows = [
    { id: 't1', type: 'tab', label: 'Main Été', disabled: false, info: '' },
    { id: 'f1', type: 'function', z: 't1', name: 'Compute', func: 'return msg;', outputs: 1, initialize: '// init', finalize: '', libs: [], x: 100, y: 100, wires: [['d1']] },
    { id: 'd1', type: 'debug', z: 't1', name: '', active: true, x: 300, y: 100, wires: [] },
    { id: 'u1', type: 'ui-template', z: 't1', name: 'Card', format: '<template><div>card</div></template>', x: 100, y: 200, wires: [[]] },
    { id: 'tp1', type: 'template', z: 't1', name: 'Mail', field: 'payload', format: 'html', template: '<p>{{payload}}</p>', x: 100, y: 300, wires: [[]] },
    { id: 's1', type: 'subflow', name: 'Helper', info: '', in: [], out: [] },
    { id: 'f2', type: 'function', z: 's1', name: 'Inner', func: 'return null;', outputs: 1, x: 100, y: 100, wires: [[]] },
    { id: 'c1', type: 'mqtt-broker', name: 'Broker', broker: 'localhost' },
    // Config node without a name: crashed flows-file-manager's disambiguate()
    { id: 'c2', type: 'ui-base', path: '/dashboard' }
]

/**
 * Load a fresh copy of the plugin against a fake RED runtime rooted in a
 * temporary userDir. Returns the registered event and HTTP handlers.
 */
function setup(splitterCfg) {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-splitter-'))
    if (splitterCfg) fs.writeFileSync(path.join(userDir, '.config.flow-splitter.json'), JSON.stringify(splitterCfg))
    const log = { info: [], warn: [], error: [] }
    const handlers = {}
    for (const file of ['../index.js', '../functions-templates-handler.js']) delete require.cache[require.resolve(file)]
    require('../index.js')({
        settings: { userDir, flowFile: 'flows.json' },
        log: { info: m => log.info.push(m), warn: m => log.warn.push(m), error: m => log.error.push(m) },
        plugins: { registerPlugin() {} },
        httpAdmin: { post: (route, handler) => { handlers.reload = handler } },
        events: { on: (event, handler) => { handlers.flowsStarted = handler } }
    })
    const flowFile = path.join(userDir, 'flows.json')
    return {
        userDir,
        log,
        src: path.join(userDir, 'src'),
        // Node-RED persists flows.json before emitting flows:started
        deploy: (nodes) => {
            fs.writeFileSync(flowFile, JSON.stringify(nodes))
            return handlers.flowsStarted({ config: { flows: nodes }, type: 'full' })
        },
        // Boot without flows.json: the plugin rebuilds it from src/
        boot: async () => {
            fs.rmSync(flowFile, { force: true })
            await handlers.flowsStarted({ config: { flows: [] }, type: 'full' })
            return JSON.parse(fs.readFileSync(flowFile, 'utf8'))
        },
        reload: () => new Promise((resolve) => {
            const res = { status: () => res, json: body => resolve(body) }
            handlers.reload({}, res)
        }).then(body => ({ body, flows: JSON.parse(fs.readFileSync(flowFile, 'utf8')) }))
    }
}

const byId = nodes => Object.fromEntries(nodes.map(node => [node.id, node]))

for (const fileFormat of ['json', 'yaml']) {
    test(`${fileFormat}: split then rebuild returns the original flows`, async () => {
        const env = setup({ fileFormat })
        await env.deploy(flows)
        assert.deepStrictEqual(fs.readdirSync(path.join(env.src, 'tabs')).sort(), ['main-t', `main-t.${fileFormat}`].sort())
        assert.deepStrictEqual(byId(await env.boot()), byId(flows))
        assert.deepStrictEqual(env.log.error, [])
    })
}

test('extracts function, ui-template and template code', async () => {
    const env = setup()
    await env.deploy(flows)
    const dir = path.join(env.src, 'tabs', 'main-t')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'Compute.js'), 'utf8'), 'return msg;')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'Compute.initialize.js'), 'utf8'), '// init')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'Card.vue'), 'utf8'), '<template><div>card</div></template>')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'Mail.html'), 'utf8'), '<p>{{payload}}</p>')
    assert.ok(!fs.existsSync(path.join(dir, 'Compute.finalize.js')))
    assert.strictEqual(fs.readFileSync(path.join(env.src, 'subflows', 'helper', 'Inner.js'), 'utf8'), 'return null;')
})

test('boot restores edited code only when restoreFunctionsTemplates is set', async () => {
    for (const restoreFunctionsTemplates of [false, true]) {
        const env = setup({ restoreFunctionsTemplates })
        await env.deploy(flows)
        fs.writeFileSync(path.join(env.src, 'tabs', 'main-t', 'Compute.js'), 'return 42;')
        const rebuilt = byId(await env.boot())
        assert.strictEqual(rebuilt.f1.func, restoreFunctionsTemplates ? 'return 42;' : 'return msg;')
    }
})

test('manual reload applies edited code and reloads flows', async () => {
    const env = setup()
    await env.deploy(flows)
    fs.writeFileSync(path.join(env.src, 'subflows', 'helper', 'Inner.js'), 'return 1;')
    const loads = privateRED.loads
    const { body, flows: reloaded } = await env.reload()
    assert.strictEqual(body.success, true)
    assert.strictEqual(byId(reloaded).f2.func, 'return 1;')
    assert.strictEqual(privateRED.loads, loads + 1)
})

test('renamed and deleted tabs leave no stale files behind', async () => {
    const env = setup()
    await env.deploy(flows)
    await env.deploy(flows.map(node => node.id === 't1' ? { ...node, label: 'Renamed' } : node).filter(node => node.id !== 's1' && node.z !== 's1'))
    assert.deepStrictEqual(fs.readdirSync(path.join(env.src, 'tabs')).sort(), ['renamed', 'renamed.json'])
    assert.deepStrictEqual(fs.readdirSync(path.join(env.src, 'subflows')), [])
})

test('falls back to the artifact when src/ is corrupted', async () => {
    const env = setup()
    await env.deploy(flows)
    fs.writeFileSync(path.join(env.src, 'tabs', 'main-t.json'), '{ not json')
    assert.deepStrictEqual(byId(await env.boot()), byId(flows))
    assert.match(env.log.warn.join('\n'), /restored flows from artifact backup/)
})
